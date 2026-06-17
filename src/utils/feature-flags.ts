/**
 * src/utils/feature-flags.ts
 *
 * US-ADM-4.2.1: Feature Flags & VIP Beta Rollout System
 *
 * isFeatureEnabled(workspaceId, flagKey) — deterministic per-workspace rollout
 * using a murmurhash-inspired hash so results never flicker between requests.
 *
 * Evaluation order:
 *   1. VIP whitelist (allowedWorkspaceIds) → always true
 *   2. Flag disabled globally (enabled=false) → always false
 *   3. Tier restriction (allowedTiers) → false if workspace tier not in list
 *   4. Rollout % → murmurhash(`${workspaceId}:${flagKey}`) % 100 < rolloutPercentage
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { featureFlags, plans, masterPlans } from '../../db/schema';

// ── Minimal 32-bit murmurhash3 (no external dependency) ──────────────────────
function murmurhash3(str: string): number {
    let h = 0xdeadbeef;
    for (let i = 0; i < str.length; i++) {
        let k = str.charCodeAt(i);
        k = Math.imul(k, 0xcc9e2d51);
        k = (k << 15) | (k >>> 17);
        k = Math.imul(k, 0x1b873593);
        h ^= k;
        h = (h << 13) | (h >>> 19);
        h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    }
    h ^= str.length;
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0; // unsigned 32-bit
}

// ── In-process cache (30s TTL, keyed by flagKey) ──────────────────────────────
interface FlagCacheEntry {
    flag: {
        enabled: boolean;
        rolloutPercentage: number;
        allowedWorkspaceIds: number[] | null;
        allowedTiers: string[] | null;
    } | null;
    expiresAt: number;
}

const flagCache = new Map<string, FlagCacheEntry>();
const FLAG_CACHE_TTL_MS = 30_000;

async function getFlag(flagKey: string): Promise<FlagCacheEntry['flag']> {
    const now = Date.now();
    const cached = flagCache.get(flagKey);
    if (cached && cached.expiresAt > now) return cached.flag;

    const db = getDb();
    const [row] = await db
        .select({
            enabled:             featureFlags.enabled,
            rolloutPercentage:   featureFlags.rolloutPercentage,
            allowedWorkspaceIds: featureFlags.allowedWorkspaceIds,
            allowedTiers:        featureFlags.allowedTiers,
        })
        .from(featureFlags)
        .where(eq(featureFlags.key, flagKey))
        .limit(1);

    const flag = row ?? null;
    flagCache.set(flagKey, { flag, expiresAt: now + FLAG_CACHE_TTL_MS });
    return flag;
}

/** Invalidate the cache for a flag key after admin writes. */
export function invalidateFeatureFlag(key: string): void {
    flagCache.delete(key);
}

/**
 * Evaluate whether a feature flag is enabled for a given workspace.
 * Returns false if the flag doesn't exist or if there's a DB error.
 *
 * @param workspaceId  The organisation/workspace ID (integer)
 * @param flagKey      The flag key string, e.g. 'new_onboarding_flow'
 * @param tierKey      Optional: the workspace's current plan tier (e.g. 'saver')
 */
export async function isFeatureEnabled(
    workspaceId: number,
    flagKey: string,
    tierKey?: string | null,
): Promise<boolean> {
    try {
        const flag = await getFlag(flagKey);
        if (!flag) return false;

        // 1. VIP whitelist always wins
        if (flag.allowedWorkspaceIds && flag.allowedWorkspaceIds.includes(workspaceId)) {
            return true;
        }

        // 2. Global toggle
        if (!flag.enabled) return false;

        // 3. Tier restriction — if allowedTiers is set and non-empty, workspace tier must match
        if (flag.allowedTiers && flag.allowedTiers.length > 0) {
            if (!tierKey || !flag.allowedTiers.includes(tierKey)) return false;
        }

        // 4. Deterministic rollout percentage
        if (flag.rolloutPercentage <= 0) return false;
        if (flag.rolloutPercentage >= 100) return true;

        const hash = murmurhash3(`${workspaceId}:${flagKey}`);
        return (hash % 100) < flag.rolloutPercentage;

    } catch (err) {
        console.error(`[feature-flags] Error evaluating flag "${flagKey}":`, err);
        return false; // fail closed
    }
}

/**
 * Estimate how many workspaces will be affected by a rollout % change.
 * Used by the admin portal preview before saving.
 *
 * @param flagKey           The flag key
 * @param newRolloutPct     The proposed new rollout percentage
 * @returns                 { current: number, projected: number, delta: number }
 */
export async function estimateRolloutImpact(flagKey: string, newRolloutPct: number): Promise<{
    current: number;
    projected: number;
    delta: number;
}> {
    const db = getDb();

    // Get all active workspace IDs
    const activeWorkspaces = await db
        .select({ orgId: plans.organisationId })
        .from(plans)
        .where(eq(plans.status, 'active'));

    const ids = activeWorkspaces.map(w => w.orgId).filter((id): id is number => id !== null);

    const flag = await getFlag(flagKey);
    const currentPct  = flag?.rolloutPercentage ?? 0;
    const whitelistIds = new Set(flag?.allowedWorkspaceIds ?? []);

    let current = 0;
    let projected = 0;

    for (const id of ids) {
        if (whitelistIds.has(id)) { current++; projected++; continue; }
        const hash = murmurhash3(`${id}:${flagKey}`);
        const bucket = hash % 100;
        if (bucket < currentPct)  current++;
        if (bucket < newRolloutPct) projected++;
    }

    return { current, projected, delta: projected - current };
}
