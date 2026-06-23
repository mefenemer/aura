// src/utils/assistant-lifecycle.ts
// Digital Assistant Lifecycle Management — canonical state machine + transition helper.
//
// The six states an assistant can occupy. `lifecycle_status` on ai_assistants is the source
// of truth (db/assistant-lifecycle-status.sql). A DB trigger keeps it derived from the legacy
// (provisioning_status, is_active) pair for existing write sites; this helper is the forward
// API for explicit, validated transitions — including ready_for_work, which has no legacy equivalent.

import { eq, and } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { aiAssistants, auditLogs } from '../../db/schema';

export const ASSISTANT_STATES = [
    'provisioning',
    'ready_for_work',
    'working',
    'paused',
    'system_paused',
    'archived',
] as const;

export type AssistantLifecycleStatus = (typeof ASSISTANT_STATES)[number];

// Legal transition graph. `archived` is terminal (US6: cannot be undone). Note that the
// historical "auto-activate on provisioning complete" path (provisioning → working) is driven
// by the legacy fields + DB trigger, NOT this helper; US3 will route it through ready_for_work.
export const LEGAL_TRANSITIONS: Record<AssistantLifecycleStatus, AssistantLifecycleStatus[]> = {
    provisioning:   ['ready_for_work', 'system_paused', 'archived'],
    ready_for_work: ['working', 'system_paused', 'archived'],
    working:        ['paused', 'system_paused', 'archived'],
    paused:         ['working', 'system_paused', 'archived'],
    system_paused:  ['ready_for_work', 'working', 'archived'],
    archived:       [],
};

export function isLegalTransition(from: AssistantLifecycleStatus, to: AssistantLifecycleStatus): boolean {
    return from === to || LEGAL_TRANSITIONS[from]?.includes(to) === true;
}

export type TransitionResult =
    | { ok: true; from: AssistantLifecycleStatus; to: AssistantLifecycleStatus; noop: boolean }
    | { ok: false; error: string; from?: AssistantLifecycleStatus };

/**
 * Move an assistant to a new lifecycle state, enforcing the legal transition graph and writing
 * an audit-log entry. Also keeps the legacy `is_active` flag aligned (working ⇒ active; every
 * other state ⇒ inactive) so existing job/connector gates that read is_active stay correct.
 *
 * @param force  bypass the legal-transition check (for admin/system overrides). Audited the same.
 */
export async function transitionAssistantStatus(
    db: PostgresJsDatabase<any>,
    assistantId: number,
    to: AssistantLifecycleStatus,
    opts: { reason?: string; actorUserId?: number; force?: boolean } = {},
): Promise<TransitionResult> {
    const [current] = await db
        .select({ lifecycleStatus: aiAssistants.lifecycleStatus, organisationId: aiAssistants.organisationId })
        .from(aiAssistants)
        .where(eq(aiAssistants.id, assistantId))
        .limit(1);

    if (!current) return { ok: false, error: `Assistant ${assistantId} not found.` };

    const from = current.lifecycleStatus as AssistantLifecycleStatus;

    if (from === to) return { ok: true, from, to, noop: true };

    if (!opts.force && !isLegalTransition(from, to)) {
        return { ok: false, error: `Illegal lifecycle transition: ${from} → ${to}.`, from };
    }

    await db.update(aiAssistants)
        .set({ lifecycleStatus: to, isActive: to === 'working', updatedAt: new Date() })
        .where(eq(aiAssistants.id, assistantId));

    await db.insert(auditLogs).values({
        userId: opts.actorUserId ?? null,
        actionType: `assistant_lifecycle_${to}`,
        resourceType: 'ai_assistants',
        resourceId: String(assistantId),
        previousState: { lifecycleStatus: from },
        newState: { lifecycleStatus: to, organisationId: current.organisationId, reason: opts.reason ?? null },
    });

    return { ok: true, from, to, noop: false };
}

/**
 * US5 (AC5.1): force a workspace's currently-working assistants into `system_paused` when a
 * critical dependency breaks (e.g. an OAuth token can't be refreshed). Scoped to a single
 * assistant when `assistantId` is given (assistant-scoped connection), otherwise the whole org
 * (a shared org-pool connection). Only `working` assistants are affected — provisioning,
 * ready_for_work, paused and archived are left alone. Returns the number transitioned.
 */
export async function systemPauseWorkingAssistants(
    db: PostgresJsDatabase<any>,
    filter: { organisationId: number; assistantId?: number | null },
    reason: string,
): Promise<number> {
    const conds = [
        eq(aiAssistants.organisationId, filter.organisationId),
        eq(aiAssistants.lifecycleStatus, 'working'),
    ];
    if (filter.assistantId) conds.push(eq(aiAssistants.id, filter.assistantId));

    const rows = await db.select({ id: aiAssistants.id }).from(aiAssistants).where(and(...conds));

    let paused = 0;
    for (const r of rows) {
        const res = await transitionAssistantStatus(db, r.id, 'system_paused', { reason });
        if (res.ok && !res.noop) paused++;
    }
    return paused;
}
