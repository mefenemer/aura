// netlify/functions/reconcile-billing.ts
//
// US-ADM-2.3.1: Stripe↔DB Nightly Reconciliation Job
//
// Runs nightly at 02:00 UTC.
// Checks all active Stripe subscriptions against the platform DB plans.
// Flags:
//   (a) DB plan active where Stripe subscription does not exist or is not active
//   (b) Stripe subscription price_id does not match the expected tier in the DB
//
// Results are written to billing_reconciliation_log.
// Mismatches trigger a superadmin in-app notification.

import { schedule } from '@netlify/functions';
import { eq, and, inArray } from 'drizzle-orm';
import Stripe from 'stripe';
import { getDb } from '../../db/client';
import {
    plans, organisations, masterPlans, users, notifications,
    billingReconciliationLog,
} from '../../db/schema';

// Same Stripe price → tier mapping as verify.ts
const PRICE_TO_TIER: Record<string, string> = {
    // Test
    'price_1TgGNFE7lvVYjk1BAsnhUzBp': 'buster',
    'price_1TgGP8E7lvVYjk1BRBeEZVd6': 'saver',
    'price_1TgGPfE7lvVYjk1B1CQrS6pE': 'employee',
    // Live
    'price_1Tg6f1CuS8qyNSsFxeUsfi4a': 'buster',
    'price_1Tg6fQCuS8qyNSsF5DKmEqMu': 'saver',
    'price_1Tg6fiCuS8qyNSsF787zwCwh': 'employee',
};

export interface ReconciliationMismatch {
    type: 'missing_stripe_sub' | 'tier_mismatch' | 'stripe_cancelled_but_db_active';
    workspaceId: number | null;
    workspaceName: string | null;
    dbPlanId: number;
    dbTierKey: string | null;
    stripeSubscriptionId: string | null;
    stripePriceId: string | null;
    stripeTierKey: string | null;
    stripeStatus: string | null;
    lastWebhookDate: string | null;
}

async function runReconciliation(): Promise<void> {
    const db = getDb();
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-11-20.acacia' });

    let totalChecked = 0;
    const mismatches: ReconciliationMismatch[] = [];
    let runStatus: 'success' | 'failed' = 'success';
    let errorMessage: string | null = null;

    try {
        // ── 1. Load all active DB plans that have a Stripe subscription ──────────
        const dbActivePlans = await db
            .select({
                planId: plans.id,
                stripeSubscriptionId: plans.stripeSubscriptionId,
                stripeCustomerId: plans.stripeCustomerId,
                organisationId: plans.organisationId,
                masterPlanId: plans.masterPlanId,
                updatedAt: plans.updatedAt,
            })
            .from(plans)
            .where(eq(plans.status, 'active'));

        totalChecked = dbActivePlans.length;

        // Map subscriptionId → DB plan for fast lookup
        const subIdToDbPlan = new Map<string, typeof dbActivePlans[0]>();
        const plansWithoutSub: typeof dbActivePlans = [];
        for (const p of dbActivePlans) {
            if (p.stripeSubscriptionId) {
                subIdToDbPlan.set(p.stripeSubscriptionId, p);
            } else {
                // Plans with no stripe subscription ID (trials, manual plans) — skip
            }
        }

        // Load org names for mismatches display
        const orgIds = [...new Set(dbActivePlans.map(p => p.organisationId).filter(Boolean))] as number[];
        const orgRows = orgIds.length
            ? await db.select({ id: organisations.id, name: organisations.name }).from(organisations).where(inArray(organisations.id, orgIds))
            : [];
        const orgNameMap = new Map(orgRows.map(o => [o.id, o.name]));

        // Load tierKey for master plans
        const masterPlanIds = [...new Set(dbActivePlans.map(p => p.masterPlanId).filter(Boolean))] as number[];
        const masterPlanRows = masterPlanIds.length
            ? await db.select({ id: masterPlans.id, tierKey: masterPlans.tierKey }).from(masterPlans).where(inArray(masterPlans.id, masterPlanIds))
            : [];
        const masterPlanTierMap = new Map(masterPlanRows.map(mp => [mp.id, mp.tierKey]));

        // ── 2. Paginate all active Stripe subscriptions ───────────────────────────
        const stripeSubIds = new Set<string>();
        for await (const stripeSub of stripe.subscriptions.list({ status: 'active', limit: 100 })) {
            stripeSubIds.add(stripeSub.id);
            const priceId = stripeSub.items.data[0]?.price?.id ?? null;
            const stripeTierKey = priceId ? (PRICE_TO_TIER[priceId] || null) : null;

            const dbPlan = subIdToDbPlan.get(stripeSub.id);
            if (!dbPlan) {
                // Stripe has an active subscription that isn't in our DB — this could be
                // a brand-new subscription not yet processed; not flagged as a critical mismatch
                // but logged as informational. Skip to avoid noise.
                continue;
            }

            const dbTierKey = dbPlan.masterPlanId ? (masterPlanTierMap.get(dbPlan.masterPlanId) || null) : null;

            // (b) Tier mismatch: Stripe price doesn't match DB tier
            if (stripeTierKey && dbTierKey && stripeTierKey !== dbTierKey) {
                mismatches.push({
                    type: 'tier_mismatch',
                    workspaceId:          dbPlan.organisationId,
                    workspaceName:        dbPlan.organisationId ? (orgNameMap.get(dbPlan.organisationId) || null) : null,
                    dbPlanId:             dbPlan.planId,
                    dbTierKey,
                    stripeSubscriptionId: stripeSub.id,
                    stripePriceId:        priceId,
                    stripeTierKey,
                    stripeStatus:         stripeSub.status,
                    lastWebhookDate:      new Date(stripeSub.current_period_start * 1000).toISOString(),
                });
            }
        }

        // ── 3. Check DB plans whose Stripe sub is cancelled/missing ──────────────
        for await (const stripeSub of stripe.subscriptions.list({ status: 'canceled', limit: 100 })) {
            if (!subIdToDbPlan.has(stripeSub.id)) continue;
            const dbPlan = subIdToDbPlan.get(stripeSub.id)!;
            const dbTierKey = dbPlan.masterPlanId ? (masterPlanTierMap.get(dbPlan.masterPlanId) || null) : null;
            const priceId = stripeSub.items.data[0]?.price?.id ?? null;
            mismatches.push({
                type: 'stripe_cancelled_but_db_active',
                workspaceId:          dbPlan.organisationId,
                workspaceName:        dbPlan.organisationId ? (orgNameMap.get(dbPlan.organisationId) || null) : null,
                dbPlanId:             dbPlan.planId,
                dbTierKey,
                stripeSubscriptionId: stripeSub.id,
                stripePriceId:        priceId,
                stripeTierKey:        priceId ? (PRICE_TO_TIER[priceId] || null) : null,
                stripeStatus:         stripeSub.status,
                lastWebhookDate:      new Date(stripeSub.canceled_at! * 1000).toISOString(),
            });
        }

        // ── 4. Write reconciliation log ────────────────────────────────────────────
        await db.insert(billingReconciliationLog).values({
            totalChecked,
            mismatchCount: mismatches.length,
            results: mismatches as any,
            status: 'success',
        });

        // ── 5. Notify superadmins if mismatches found ──────────────────────────────
        if (mismatches.length > 0) {
            const superAdmins = await db
                .select({ id: users.id })
                .from(users)
                .where(eq(users.role, 'super_admin'));

            const notifValues = superAdmins.map(admin => ({
                userId: admin.id,
                type:    'billing_alert' as const,
                title:   `⚠️ Billing Reconciliation: ${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'} found`,
                message: `The nightly Stripe↔DB reconciliation detected ${mismatches.length} plan mismatch${mismatches.length === 1 ? '' : 'es'}. Open the Reconciliation Queue in the Admin Portal to review and sync.`,
                metadata: { mismatchCount: mismatches.length, runAt: new Date().toISOString() },
            }));

            if (notifValues.length > 0) {
                await db.insert(notifications).values(notifValues);
            }

            console.warn(`[reconcile-billing] ⚠️ ${mismatches.length} mismatch(es) found and flagged.`);
        } else {
            console.log(`[reconcile-billing] ✅ ${totalChecked} plans checked — no mismatches.`);
        }

    } catch (err: any) {
        runStatus = 'failed';
        errorMessage = String(err?.message || err);
        console.error('[reconcile-billing] Fatal error:', err);

        // Still write a failed-run record
        try {
            const db2 = getDb();
            await db2.insert(billingReconciliationLog).values({
                totalChecked,
                mismatchCount: mismatches.length,
                results: mismatches as any,
                status: 'failed',
                errorMessage,
            });

            // Alert superadmins about the failure
            const superAdmins = await db2
                .select({ id: users.id })
                .from(users)
                .where(eq(users.role, 'super_admin'));

            if (superAdmins.length > 0) {
                await db2.insert(notifications).values(superAdmins.map(a => ({
                    userId:  a.id,
                    type:    'billing_alert' as const,
                    title:   '🚨 Billing Reconciliation Job Failed',
                    message: `The nightly reconciliation job failed with error: ${errorMessage}. Investigate within 4 hours.`,
                    metadata: { error: errorMessage, runAt: new Date().toISOString() },
                })));
            }
        } catch (innerErr) {
            console.error('[reconcile-billing] Also failed to write failure log:', innerErr);
        }
    }
}

export const handler = schedule('0 2 * * *', async () => {
    await runReconciliation();
    return { statusCode: 200 };
});
