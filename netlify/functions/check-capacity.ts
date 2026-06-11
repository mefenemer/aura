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
//   nextPlan: { tierKey, name, monthlyPriceGbp, assistantLimit } | null,  // null = already on highest plan
// }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq, and, gte, gt, count, sum, asc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { plans, masterPlans, aiAssistants, taskRuns, userOrganisations, users } from '../../db/schema';

const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;

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
                planType: plans.planType,
                expiresAt: plans.expiresAt,
                gracePeriodEndsAt: plans.gracePeriodEndsAt,
                masterPlanId: plans.masterPlanId,
                tierKey: masterPlans.tierKey,
                tierName: masterPlans.name,
                monthlyPriceGbp: masterPlans.monthlyPriceGbp,
                assistantLimit: masterPlans.assistantLimit,
                monthlyTaskLimit: masterPlans.monthlyTaskLimit,
                monthlyTokenLimit: masterPlans.monthlyTokenLimit,
                appConnectionLimit: masterPlans.appConnectionLimit,
                seatLimit: masterPlans.seatLimit,
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
                    planType: plans.planType,
                    expiresAt: plans.expiresAt,
                    gracePeriodEndsAt: plans.gracePeriodEndsAt,
                    masterPlanId: plans.masterPlanId,
                    stripeCustomerId: plans.stripeCustomerId,
                    tierKey: masterPlans.tierKey,
                    tierName: masterPlans.name,
                    monthlyPriceGbp: masterPlans.monthlyPriceGbp,
                    assistantLimit: masterPlans.assistantLimit,
                    monthlyTaskLimit: masterPlans.monthlyTaskLimit,
                    monthlyTokenLimit: masterPlans.monthlyTokenLimit,
                    appConnectionLimit: masterPlans.appConnectionLimit,
                    seatLimit: masterPlans.seatLimit,
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
        const seatLimit: number | null = plan?.seatLimit ?? null;

        // ── 2. Count active assistants & workspace seats used ───────
        const [{ value: assistantCount }] = await db
            .select({ value: count() })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.userId, userId), eq(aiAssistants.isActive, true)));

        // Seat count = number of active users in the same organisation
        const [userOrg] = await db
            .select({ organisationId: users.organisationId })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);

        let seatCount = 1; // default: just the owner
        if (userOrg?.organisationId) {
            const [{ value: orgMemberCount }] = await db
                .select({ value: count() })
                .from(userOrganisations)
                .where(eq(userOrganisations.organisationId, userOrg.organisationId));
            seatCount = orgMemberCount || 1;
        }

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

        // ── 5. Resolve next plan tier (for upgrade modal SC2 / SC5) ──────────
        // Find the cheapest plan that costs more than the current plan — that's the next tier up.
        // Returns null if the user is already on the highest-paid plan (enterprise contact path).
        let nextPlan: { tierKey: string; name: string; monthlyPriceGbp: string; assistantLimit: number | null } | null = null;
        if (plan?.monthlyPriceGbp != null) {
            const [nextTierRow] = await db
                .select({
                    tierKey: masterPlans.tierKey,
                    name: masterPlans.name,
                    monthlyPriceGbp: masterPlans.monthlyPriceGbp,
                    assistantLimit: masterPlans.assistantLimit,
                })
                .from(masterPlans)
                .where(and(
                    eq(masterPlans.isActive, true),
                    gt(masterPlans.monthlyPriceGbp, plan.monthlyPriceGbp as any),
                ))
                .orderBy(asc(masterPlans.monthlyPriceGbp))
                .limit(1);
            nextPlan = nextTierRow ?? null;
        }

        // ── 6. Grace period — expose expiry for UI warning banner ───
        const gracePeriodEndsAt = plan?.gracePeriodEndsAt
            ? (plan.gracePeriodEndsAt as Date).toISOString()
            : null;
        const graceExpired = gracePeriodEndsAt ? new Date() > new Date(gracePeriodEndsAt) : false;

        // ── 7. US-GAP-3.1.1 SC1/SC2: past_due invoice details for Payment Required banner ─
        let pastDueAmountGbp: string | null = null;
        let pastDueAttemptCount: number | null = null;
        let stripePortalUrl: string | null = null;
        if (plan?.planStatus === 'past_due' && (plan as any).stripeCustomerId && stripe) {
            try {
                const openInvoices = await stripe.invoices.list({
                    customer: (plan as any).stripeCustomerId,
                    status: 'open',
                    limit: 1,
                });
                const inv = openInvoices.data[0];
                if (inv) {
                    pastDueAmountGbp  = ((inv.amount_due || 0) / 100).toFixed(2);
                    pastDueAttemptCount = (inv as any).attempt_count ?? null;
                }
                // Generate Stripe billing portal URL
                const portal = await stripe.billingPortal.sessions.create({
                    customer: (plan as any).stripeCustomerId,
                    return_url: (process.env.BASE_URL || '') + '/billing.html',
                });
                stripePortalUrl = portal.url;
            } catch { /* non-critical — banner will still show without amount */ }
        }

        const seatPct = seatLimit
            ? Math.min(100, Math.round((seatCount / seatLimit) * 100))
            : 0;

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
                seatCount,
                seatLimit,
                seatPct,
                assistantPct,
                taskPct,
                tokenPct,
                tierKey: plan?.tierKey ?? null,
                tierName: plan?.tierName ?? null,
                planStatus: plan?.planStatus ?? null,
                planType: plan?.planType ?? null,
                gracePeriodEndsAt,
                graceExpired,    // true if grace period has passed and access should be blocked
                // US-GAP-8.1.1 SC3: trial countdown badge data
                isTrial: plan?.planType === 'trial',
                trialExpiresAt: plan?.planType === 'trial' && plan?.expiresAt
                    ? (plan.expiresAt instanceof Date ? plan.expiresAt : new Date(plan.expiresAt as string)).toISOString()
                    : null,
                trialDaysRemaining: plan?.planType === 'trial' && plan?.expiresAt
                    ? Math.max(0, Math.ceil((new Date(plan.expiresAt instanceof Date ? plan.expiresAt : plan.expiresAt as string).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
                    : null,
                pastDueAmountGbp,    // amount owed on open Stripe invoice (SC2)
                pastDueAttemptCount, // number of charge attempts (SC2)
                stripePortalUrl,     // Stripe billing portal URL for payment update CTA (SC2)
                nextPlan,        // next tier up — null if already on highest plan
            }),
        };

    } catch (err: any) {
        console.error('[check-capacity]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to check capacity.' }) };
    }
};
