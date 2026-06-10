// check-capacity.ts
// GET → returns the authenticated user's assistant & task capacity metrics.
// Used by the workspace before letting the user hire a new assistant (SC2)
// and by the task-volume notification logic (SC3).
//
// Response shape:
// {
//   assistantCount: number,          // active assistants right now
//   assistantLimit: number|null,     // null = unlimited
//   taskCount: number,               // task_runs this calendar month
//   taskLimit: number|null,          // null = unlimited
//   tokenUsage: number,              // tokens used this calendar month (sum of taskRuns.tokensUsed)
//   monthlyTokenLimit: number|null,  // null = unlimited
//   appConnectionLimit: number|null, // per-assistant max connections; null = unlimited
//   assistantPct: number,            // 0-100
//   taskPct: number,                 // 0-100
//   tokenPct: number,                // 0-100
//   tierKey: string|null,
//   tierName: string|null,
//   gracePeriodEndsAt: string|null,  // ISO string if plan is past_due with grace period active
// }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, gte, count, sum } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { plans, masterPlans, aiAssistants, taskRuns } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(cookie, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    try {
        const db = getDb();

        // ── 1. Resolve the user's current active plan & its limits ──
        const activePlan = await db
            .select({
                planId: plans.id,
                planStatus: plans.status,
                gracePeriodEndsAt: plans.gracePeriodEndsAt,
                masterPlanId: plans.masterPlanId,
                tierKey: masterPlans.tierKey,
                tierName: masterPlans.name,
                assistantLimit: masterPlans.assistantLimit,
                monthlyTaskLimit: masterPlans.monthlyTaskLimit,
                monthlyTokenLimit: masterPlans.monthlyTokenLimit,
                appConnectionLimit: masterPlans.appConnectionLimit,
            })
            .from(plans)
            .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
            .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
            .orderBy(plans.startedAt)
            .limit(1);

        // Also check for past_due plans (grace period)
        const pastDuePlan = activePlan.length === 0
            ? await db
                .select({
                    planId: plans.id,
                    planStatus: plans.status,
                    gracePeriodEndsAt: plans.gracePeriodEndsAt,
                    masterPlanId: plans.masterPlanId,
                    tierKey: masterPlans.tierKey,
                    tierName: masterPlans.name,
                    assistantLimit: masterPlans.assistantLimit,
                    monthlyTaskLimit: masterPlans.monthlyTaskLimit,
                    monthlyTokenLimit: masterPlans.monthlyTokenLimit,
                    appConnectionLimit: masterPlans.appConnectionLimit,
                })
                .from(plans)
                .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
                .where(and(eq(plans.userId, userId), eq(plans.status, 'past_due')))
                .orderBy(plans.startedAt)
                .limit(1)
            : [];

        const plan = activePlan[0] ?? pastDuePlan[0] ?? null;
        const assistantLimit: number | null = plan?.assistantLimit ?? null;
        const monthlyTaskLimit: number | null = plan?.monthlyTaskLimit ?? null;
        const monthlyTokenLimit: number | null = plan?.monthlyTokenLimit ?? null;
        const appConnectionLimit: number | null = plan?.appConnectionLimit ?? null;

        // ── 2. Count active assistants ──────────────────────────────
        const [{ value: assistantCount }] = await db
            .select({ value: count() })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.userId, userId), eq(aiAssistants.isActive, true)));

        // ── 3. Count task_runs and sum tokens this calendar month ───
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const [taskStats] = await db
            .select({ taskCount: count(), tokenUsage: sum(taskRuns.tokensUsed) })
            .from(taskRuns)
            .where(and(
                eq(taskRuns.userId, userId),
                gte(taskRuns.createdAt, monthStart),
            ));

        const taskCount = taskStats?.taskCount ?? 0;
        const tokenUsage = Number(taskStats?.tokenUsage ?? 0);

        // ── 4. Compute percentages ──────────────────────────────────
        const assistantPct = assistantLimit
            ? Math.min(100, Math.round((assistantCount / assistantLimit) * 100))
            : 0;
        const taskPct = monthlyTaskLimit
            ? Math.min(100, Math.round((taskCount / monthlyTaskLimit) * 100))
            : 0;
        const tokenPct = monthlyTokenLimit
            ? Math.min(100, Math.round((tokenUsage / monthlyTokenLimit) * 100))
            : 0;

        // ── 5. Grace period — expose expiry for UI warning banner ───
        const gracePeriodEndsAt = plan?.gracePeriodEndsAt
            ? (plan.gracePeriodEndsAt as Date).toISOString()
            : null;
        const graceExpired = gracePeriodEndsAt ? new Date() > new Date(gracePeriodEndsAt) : false;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                assistantCount,
                assistantLimit,
                taskCount,
                taskLimit: monthlyTaskLimit,
                tokenUsage,
                monthlyTokenLimit,
                appConnectionLimit,
                assistantPct,
                taskPct,
                tokenPct,
                tierKey: plan?.tierKey ?? null,
                tierName: plan?.tierName ?? null,
                planStatus: plan?.planStatus ?? null,
                gracePeriodEndsAt,
                graceExpired,    // true if grace period has passed and access should be blocked
            }),
        };

    } catch (err: any) {
        console.error('[check-capacity]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to check capacity.' }) };
    }
};
