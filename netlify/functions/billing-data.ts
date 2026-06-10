// billing-data.ts — Billing area data endpoint
// GET → returns { subscriptions, payments } for the authenticated user
// Combines local DB records with live Stripe enrichment (renewal date,
// card details, invoice PDF URLs).

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq, desc, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, payments, masterPlans } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;
const stripeSecret = process.env.STRIPE_SECRET_KEY;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // ── Auth ──────────────────────────────────────────────────────
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

        // ── 1. Local DB: plans ────────────────────────────────────
        const userPlans = await db
            .select({
                id: plans.id,
                planName: plans.planName,
                planType: plans.planType,
                status: plans.status,
                startedAt: plans.startedAt,
                expiresAt: plans.expiresAt,
                masterPlanId: plans.masterPlanId,
            })
            .from(plans)
            .where(eq(plans.userId, userId))
            .orderBy(desc(plans.startedAt));

        // Enrich plans with masterPlan price
        const masterPlanIds = [...new Set(userPlans.map(p => p.masterPlanId).filter(Boolean) as number[])];
        const masterPlanMap: Record<number, { monthlyPriceGbp: string; tierKey: string }> = {};
        if (masterPlanIds.length > 0) {
            for (const mpId of masterPlanIds) {
                const [mp] = await db.select({
                    id: masterPlans.id,
                    monthlyPriceGbp: masterPlans.monthlyPriceGbp,
                    tierKey: masterPlans.tierKey,
                }).from(masterPlans).where(eq(masterPlans.id, mpId));
                if (mp) masterPlanMap[mpId] = mp;
            }
        }

        // ── 2. Local DB: payment history ──────────────────────────
        const userPayments = await db
            .select({
                id: payments.id,
                planId: payments.planId,
                amount: payments.amount,
                currency: payments.currency,
                status: payments.status,
                paymentMethod: payments.paymentMethod,
                externalPaymentId: payments.externalPaymentId,
                description: payments.description,
                cardBrand: payments.cardBrand,
                cardLast4: payments.cardLast4,
                cardExpMonth: payments.cardExpMonth,
                cardExpYear: payments.cardExpYear,
                createdAt: payments.createdAt,
                paidAt: payments.paidAt,
            })
            .from(payments)
            .where(eq(payments.userId, userId))
            .orderBy(desc(payments.createdAt));

        // ── 3. Stripe enrichment (non-fatal if unavailable) ───────
        let stripeCustomerId: string | null = null;
        let stripeSubscriptions: any[] = [];
        let stripePaymentMethods: Record<string, any> = {};
        let stripeInvoiceUrls: Record<string, string> = {};

        if (stripeSecret) {
            try {
                const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

                // Find Stripe customer by userId metadata
                const customers = await stripe.customers.search({
                    query: `metadata['auraUserId']:'${userId}'`,
                    limit: 5,
                });

                // Fallback: search by email
                let customer: Stripe.Customer | null = null;
                if (customers.data.length > 0) {
                    customer = customers.data[0] as Stripe.Customer;
                } else {
                    const [user] = await db.select({ email: users.email })
                        .from(users).where(eq(users.id, userId));
                    if (user?.email) {
                        const byEmail = await stripe.customers.list({ email: user.email, limit: 5 });
                        // Pick the most recent customer that has metadata matching userId
                        customer = byEmail.data.find(c =>
                            c.metadata?.userId === String(userId) ||
                            c.metadata?.auraUserId === String(userId)
                        ) as Stripe.Customer || (byEmail.data[0] as Stripe.Customer) || null;
                    }
                }

                if (customer) {
                    stripeCustomerId = customer.id;

                    // Active subscriptions
                    const subs = await stripe.subscriptions.list({
                        customer: customer.id,
                        status: 'all',
                        limit: 20,
                        expand: ['data.default_payment_method'],
                    });

                    stripeSubscriptions = subs.data.map(sub => {
                        const pm = sub.default_payment_method as Stripe.PaymentMethod | null;
                        const card = pm?.card;
                        return {
                            id: sub.id,
                            status: sub.status,
                            currentPeriodEnd: sub.current_period_end,
                            cancelAtPeriodEnd: sub.cancel_at_period_end,
                            items: sub.items.data.map(i => ({
                                priceId: i.price.id,
                                productName: (i.price.product as any)?.name || null,
                                amount: i.price.unit_amount,
                                currency: i.price.currency,
                                interval: i.price.recurring?.interval,
                            })),
                            paymentMethod: card ? {
                                brand: card.brand,
                                last4: card.last4,
                                expMonth: card.exp_month,
                                expYear: card.exp_year,
                            } : null,
                        };
                    });

                    // Invoices for receipt URLs
                    const invoices = await stripe.invoices.list({
                        customer: customer.id,
                        limit: 50,
                    });
                    invoices.data.forEach(inv => {
                        if (inv.payment_intent && inv.hosted_invoice_url) {
                            stripeInvoiceUrls[inv.payment_intent as string] = inv.hosted_invoice_url;
                        }
                    });

                    // Payment method details for any PaymentIntents we have locally
                    const piIds = userPayments.map(p => p.externalPaymentId).filter(Boolean) as string[];
                    // Batch: for each PI, try to get card info
                    const pmFetchLimit = Math.min(piIds.length, 10); // cap to avoid rate limits
                    for (let i = 0; i < pmFetchLimit; i++) {
                        try {
                            const pi = await stripe.paymentIntents.retrieve(piIds[i], {
                                expand: ['payment_method'],
                            });
                            const pm = pi.payment_method as Stripe.PaymentMethod | null;
                            if (pm?.card) {
                                stripePaymentMethods[piIds[i]] = {
                                    brand: pm.card.brand,
                                    last4: pm.card.last4,
                                    expMonth: pm.card.exp_month,
                                    expYear: pm.card.exp_year,
                                };
                            }
                        } catch { /* skip individual PI failures */ }
                    }
                }
            } catch (stripeErr) {
                // Stripe enrichment is best-effort; fall through with DB-only data
                console.warn('[billing-data] Stripe enrichment failed:', (stripeErr as any)?.message);
            }
        }

        // ── 4. Build response ─────────────────────────────────────
        const subscriptions = userPlans.map(plan => {
            const mp = plan.masterPlanId ? masterPlanMap[plan.masterPlanId] : null;
            // Try to match a Stripe subscription by plan start proximity (best effort)
            const matchedSub = stripeSubscriptions.find(s =>
                s.status === 'active' || s.status === 'trialing'
            ) || stripeSubscriptions[0] || null;

            return {
                id: plan.id,
                planName: plan.planName,
                planType: plan.planType,
                status: plan.status,
                billingCycle: matchedSub?.items?.[0]?.interval || 'month',
                amountGbp: mp?.monthlyPriceGbp || null,
                currency: matchedSub?.items?.[0]?.currency || 'gbp',
                startedAt: plan.startedAt,
                expiresAt: plan.expiresAt,
                renewalDate: matchedSub?.currentPeriodEnd
                    ? new Date(matchedSub.currentPeriodEnd * 1000).toISOString()
                    : null,
                cancelAtPeriodEnd: matchedSub?.cancelAtPeriodEnd || false,
                stripeStatus: matchedSub?.status || null,
                stripeSubscriptionId: matchedSub?.id || null,
                paymentMethod: matchedSub?.paymentMethod || null,
            };
        });

        const paymentHistory = userPayments.map(p => {
            // Card details: DB columns are primary source of truth (stored at payment time).
            // Stripe live enrichment used as fallback for older records that pre-date the columns.
            const stripeCard = p.externalPaymentId ? stripePaymentMethods[p.externalPaymentId] : null;
            const receiptUrl = p.externalPaymentId ? stripeInvoiceUrls[p.externalPaymentId] : null;

            let cardDetails: { brand: string; last4: string; expMonth: number; expYear: number } | null = null;
            if (p.cardBrand && p.cardLast4) {
                // DB-stored card details (authoritative)
                cardDetails = {
                    brand:    p.cardBrand,
                    last4:    p.cardLast4,
                    expMonth: p.cardExpMonth!,
                    expYear:  p.cardExpYear!,
                };
            } else if (stripeCard) {
                // Stripe live enrichment fallback
                cardDetails = {
                    brand:    stripeCard.brand,
                    last4:    stripeCard.last4,
                    expMonth: stripeCard.expMonth,
                    expYear:  stripeCard.expYear,
                };
            }

            return {
                id: p.id,
                date: p.paidAt || p.createdAt,
                description: p.description || 'Aura-Assist Subscription',
                amount: p.amount,
                currency: p.currency || 'GBP',
                status: p.status,
                paymentMethod: cardDetails ?? (p.paymentMethod || null),
                receiptUrl,
            };
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscriptions, paymentHistory }),
        };

    } catch (err: any) {
        console.error('[billing-data] Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load billing data.' }) };
    }
};
