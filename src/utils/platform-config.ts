/**
 * src/utils/platform-config.ts
 *
 * US-ADM-3.2.1: Platform Kill Switches & Emergency Controls
 *
 * getPlatformConfig() — fetches platform_config from DB with a 30-second
 * in-process cache so AI calls add zero per-request DB latency.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { platformConfig } from '../../db/schema';

// ── Kill switch / config keys used across the platform ────────────────────────
export const CONFIG_KEYS = {
    GLOBAL_AI_DISABLED:     'global_ai_disabled',         // boolean — kills all AI calls
    DISABLED_MODELS:        'disabled_models',             // string[] — per-model kill list
    MAINTENANCE_MODE:       'maintenance_mode',            // boolean
    MAINTENANCE_MESSAGE:    'maintenance_message',         // string — shown to users
    NEW_REGISTRATION_LOCK:  'new_registration_lock',       // boolean — blocks new sign-ups
    // Per-workspace rate limit overrides are stored as a JSON map under this key:
    //   { [workspaceId: string]: { limit: number, expiresAt?: string } }
    WORKSPACE_RATE_LIMITS:  'workspace_rate_limits',
    // Per-workspace suspension: { [workspaceId: string]: { reason: string, suspendedAt: string } }
    SUSPENDED_WORKSPACES:   'suspended_workspaces',
} as const;

export type ConfigKey = typeof CONFIG_KEYS[keyof typeof CONFIG_KEYS];

// ── In-process cache ──────────────────────────────────────────────────────────
const CACHE_TTL_MS = 30_000;  // 30 seconds

interface CacheEntry {
    value: unknown;
    expiresAt: number;
}

const configCache = new Map<string, CacheEntry>();

/**
 * Retrieve a single config value.
 * Returns null if the key doesn't exist.
 * Uses a 30-second in-process cache per key to avoid per-request DB round-trips.
 */
export async function getPlatformConfig(key: ConfigKey): Promise<unknown> {
    const now = Date.now();
    const cached = configCache.get(key);
    if (cached && cached.expiresAt > now) {
        return cached.value;
    }

    const db = getDb();
    const [row] = await db
        .select({ value: platformConfig.value })
        .from(platformConfig)
        .where(eq(platformConfig.key, key));

    const value = row?.value ?? null;
    configCache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
}

/**
 * Bulk-load all config rows at once into the cache.
 * Called once on cold-start or when the admin updates a setting.
 */
export async function warmPlatformConfigCache(): Promise<Record<string, unknown>> {
    const db = getDb();
    const rows = await db.select({ key: platformConfig.key, value: platformConfig.value }).from(platformConfig);
    const now = Date.now();
    const result: Record<string, unknown> = {};
    for (const row of rows) {
        configCache.set(row.key, { value: row.value, expiresAt: now + CACHE_TTL_MS });
        result[row.key] = row.value;
    }
    return result;
}

/** Invalidate a single cache entry (call after admin writes a new value). */
export function invalidatePlatformConfig(key: string): void {
    configCache.delete(key);
}

/** Check the global AI kill switch. Returns true if AI is disabled. */
export async function isGlobalAiDisabled(): Promise<boolean> {
    const val = await getPlatformConfig(CONFIG_KEYS.GLOBAL_AI_DISABLED);
    return val === true;
}

/** Check if maintenance mode is active. */
export async function isMaintenanceMode(): Promise<boolean> {
    const val = await getPlatformConfig(CONFIG_KEYS.MAINTENANCE_MODE);
    return val === true;
}

/** Check if new registrations are locked. */
export async function isRegistrationLocked(): Promise<boolean> {
    const val = await getPlatformConfig(CONFIG_KEYS.NEW_REGISTRATION_LOCK);
    return val === true;
}
