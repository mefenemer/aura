// src/utils/notification-actions.ts
// Notifications: action vs info classification + auto-resolution.
//
// ACTION items require the user to DO something and are "cleared" by completing the
// task, not by reading. Everything else is informational (read/unread). This module is
// the single source of truth for that classification (imported by notifications.ts) and
// for auto-resolving open action items when the underlying problem is actually fixed.
//
// Two ways an action item clears:
//   1. resolve-on-click — clicking the card's CTA marks it read (handled in notifications.js).
//   2. auto-resolve (this module) — a real-world success event (payment taken, plan
//      upgraded, connection re-established) clears the matching open action items server-side,
//      so a stale "Update payment" card disappears the moment the payment actually succeeds.
//
// Auto-resolve is wired only for ACCOUNT-STATE actions whose condition is global to the
// user (billing/trial/connection). Per-item actions (post approvals, per-post publish
// failures) are intentionally left on resolve-on-click: clearing all of a type on one
// success would wrongly dismiss a still-open sibling item.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { notifications } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

// Action-kind notification types. Unknown types default to 'info'. Mirrored on the client
// (ACTION_TYPES_FALLBACK in notifications.js) for responses that predate kind annotation.
export const ACTION_TYPES = new Set<string>([
    'onboarding_prompt', 'onboarding_incomplete',
    'hitl_approval_required', 'review_red_urgency',
    'billing_payment_failed', 'missing_stripe_sub', 'stripe_cancelled_but_db_active',
    'tier_mismatch', 'subscription_paused', 'assistants_paused_downgrade',
    'social_oauth_revoked', 'instagram_token_refresh_failed', 'integration_alert',
    'post_publish_failed', 'post_missed', 'post_generation_failed',
    'trial_expiring_soon', 'trial_expired',
    'task_limit_reached', 'task_limit_warning',
    'run_budget_suspended', 'run_cost_warning',
    'security', 'agent_anomaly', 'risk_assessment_submitted',
]);

export const kindOf = (type: string): 'action' | 'info' => (ACTION_TYPES.has(type) ? 'action' : 'info');

// ── Resolution groups ────────────────────────────────────────────────
// Each group is the set of open action items that a given success event makes moot.

// A successful payment / restored subscription clears every "your billing is broken" prompt.
export const PAYMENT_RESTORED_TYPES = [
    'billing_payment_failed', 'missing_stripe_sub',
    'stripe_cancelled_but_db_active', 'subscription_paused',
];

// An upgrade (or any move to a higher tier with active billing) clears the
// trial / capacity / downgrade prompts that were nudging the user to upgrade.
export const PLAN_UPGRADED_TYPES = [
    'trial_expiring_soon', 'trial_expired', 'tier_mismatch',
    'assistants_paused_downgrade', 'task_limit_reached', 'task_limit_warning',
    ...PAYMENT_RESTORED_TYPES,
];

// A (re)connected / refreshed social account clears the "reconnect" prompts.
export const CONNECTION_RESTORED_TYPES = [
    'social_oauth_revoked', 'instagram_token_refresh_failed', 'integration_alert',
];

/**
 * Mark open (unread) action notifications of the given types as resolved for one user.
 * Best-effort: never throws — auto-resolve must not break the success path that triggered it.
 * Returns the number of items cleared (0 on error or when nothing was open).
 */
export async function resolveActionNotifications(
    db: Db,
    userId: number,
    types: readonly string[],
): Promise<number> {
    if (!userId || !types.length) return 0;
    try {
        const cleared = await db.update(notifications)
            .set({ isRead: true, readAt: new Date() })
            .where(and(
                eq(notifications.userId, userId),
                eq(notifications.isRead, false),
                inArray(notifications.type, [...types]),
            ))
            .returning({ id: notifications.id });
        if (cleared.length) {
            console.log(`[notifications] auto-resolved ${cleared.length} action item(s) for user ${userId}: ${types.join(', ')}`);
        }
        return cleared.length;
    } catch (err) {
        console.error('[notifications] resolveActionNotifications failed:', err);
        return 0;
    }
}
