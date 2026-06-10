import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { payments, plans, aiAssistants, onboardingDrafts, notifications, users, masterPlans } from '../../db/schema';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-05-27.dahlia' });
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const sig = event.headers['stripe-signature'];
    let stripeEvent: Stripe.Event;

    try {
        stripeEvent = stripe.webhooks.constructEvent(event.body!, sig!, webhookSecret);
    } catch (err: any) {
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    const db = getDb();

    // ── payment_intent.succeeded — initial checkout ───────────────
    if (stripeEvent.type === 'payment_intent.succeeded') {
        const pi = stripeEvent.data.object as Stripe.PaymentIntent;
        const { userId, organisationId, tier, masterPlanId, stripePriceId, stripeCustomerId } = pi.metadata || {};

        // Only handle payment intents created by our checkout flow (they have userId in metadata)
        if (!userId || !stripeCustomerId) {
            return { statusCode: 200, body: JSON.stringify({ received: true }) };
        }

        const userIdInt       = parseInt(userId);
        const orgIdInt        = parseInt(organisationId);
        const masterPlanIdInt = masterPlanId ? parseInt(masterPlanId) : null;
        const amountGbp       = pi.amount ? (pi.amount / 100).toFixed(2) : '0.00';

        // ── Expand PaymentMethod to capture card details at checkout ──
        // PAN and CVC are never stored — only brand, last4, and expiry.
        let cardBrand: string | null      = null;
        let cardLast4: string | null      = null;
        let cardExpMonth: number | null   = null;
        let cardExpYear: number | null    = null;
        let cardPostalCode: string | null = null;

        if (pi.payment_method) {
            try {
                const pm = await stripe.paymentMethods.retrieve(pi.payment_method as string);
                if (pm.card) {
                    cardBrand      = pm.card.brand     || null;
                    cardLast4      = pm.card.last4      || null;
                    cardExpMonth   = pm.card.exp_month  || null;
                    cardExpYear    = pm.card.exp_year   || null;
                }
                // Billing address postal code stored at checkout
                cardPostalCode = pm.billing_details?.address?.postal_code || null;
            } catch (pmErr) {
                console.warn('[stripe-webhook] Could not retrieve payment method for card details:', (pmErr as any)?.message);
            }
        }

        // Look up plan name
        let planName = tier ? `Aura-Assist (${tier})` : 'Aura-Assist Subscription';
        if (masterPlanIdInt) {
            const [mp] = await db.select().from(masterPlans).where(eq(masterPlans.id, masterPlanIdInt)).limit(1);
            if (mp) planName = mp.name;
        }

        // Create Stripe subscription with the saved payment method for recurring billing
        if (stripePriceId && pi.payment_method) {
            await stripe.subscriptions.create({
                customer: stripeCustomerId,
                items: [{ price: stripePriceId }],
                default_payment_method: pi.payment_method as string,
                billing_cycle_anchor: 'now',
                proration_behavior: 'none',
                metadata: { userId, organisationId, tier: tier || '', masterPlanId: masterPlanId || '' },
            }).catch(err => console.error('Subscription creation after payment failed:', err));
        }

        // Create plan record
        const [newPlan] = await db.insert(plans).values({
            userId: userIdInt,
            organisationId: orgIdInt,
            masterPlanId: masterPlanIdInt,
            planName,
            planType: 'subscription',
            status: 'active',
        }).returning();

        // Create payment record — include card details
        await db.insert(payments).values({
            userId: userIdInt,
            organisationId: orgIdInt,
            planId: newPlan.id,
            masterPlanId: masterPlanIdInt,
            amount: amountGbp,
            currency: 'GBP',
            status: 'completed',
            externalPaymentId: pi.id,
            description: `${planName} — first payment`,
            cardBrand,
            cardLast4,
            cardExpMonth,
            cardExpYear,
            cardPostalCode,
            paymentMethod: cardBrand && cardLast4 ? `${cardBrand} ending ${cardLast4}` : null,
        });

        // Notify user to complete onboarding
        await db.insert(notifications).values({
            userId: userIdInt,
            type: 'billing',
            title: 'Payment Successful — Set Up Your Assistant',
            message: 'Your subscription is active. Click "Resume Setup" on your dashboard to build your Digital Assistant now.',
            isRead: false,
        });
    }

    // ── invoice.upcoming — renewal due in ~3 days ─────────────────
    // Stripe fires this automatically 3 days before a subscription renews.
    if (stripeEvent.type === 'invoice.upcoming') {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        const userId  = await _resolveUserId(invoice.customer as string);
        if (userId) {
            const amount     = invoice.amount_due ? `£${(invoice.amount_due / 100).toFixed(2)}` : '';
            const renewalDay = invoice.period_end
                ? new Date(invoice.period_end * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
                : 'soon';

            // Avoid duplicate notifications: check if one was already sent for this period
            const existing = await db.select({ id: notifications.id })
                .from(notifications)
                .where(and(
                    eq(notifications.userId, userId),
                    eq(notifications.type, 'billing_renewal_due'),
                ))
                .limit(1);

            // Only insert if no recent renewal-due notification exists for this invoice
            const alreadySent = existing.some(n => {
                // metadata.invoiceId matches
                return (n as any).metadata?.invoiceId === invoice.id;
            });

            if (!alreadySent) {
                await db.insert(notifications).values({
                    userId,
                    type: 'billing_renewal_due',
                    title: 'Subscription Renewal Due Soon',
                    message: `Your subscription will renew on ${renewalDay}${amount ? ` for ${amount}` : ''}. Make sure your payment details are up to date.`,
                    isRead: false,
                    metadata: {
                        invoiceId: invoice.id,
                        customerId: invoice.customer,
                        amountDue: invoice.amount_due,
                        renewalDate: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
                    },
                });
            }
        }
    }

    // ── invoice.paid — successful renewal / recurring charge ──────
    // Fires on every successful invoice payment (both initial and recurring).
    // We skip the initial charge here as payment_intent.succeeded covers it.
    if (stripeEvent.type === 'invoice.paid') {
        const invoice    = stripeEvent.data.object as Stripe.Invoice;
        const billingReason = (invoice as any).billing_reason as string | undefined;

        // 'subscription_create' = first charge (already handled above); skip to avoid double notification
        if (billingReason === 'subscription_create') {
            return { statusCode: 200, body: JSON.stringify({ received: true }) };
        }

        const userId = await _resolveUserId(invoice.customer as string);
        if (userId) {
            const amount     = invoice.amount_paid ? `£${(invoice.amount_paid / 100).toFixed(2)}` : '';
            const periodEnd  = invoice.period_end
                ? new Date(invoice.period_end * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
                : null;

            // Resolve card details from the invoice's charge
            let renewCardBrand: string | null      = null;
            let renewCardLast4: string | null      = null;
            let renewCardExpMonth: number | null   = null;
            let renewCardExpYear: number | null    = null;
            let renewCardPostalCode: string | null = null;

            try {
                // invoice.payment_intent → expand payment_method → card + billing address
                if (invoice.payment_intent) {
                    const pi = await stripe.paymentIntents.retrieve(invoice.payment_intent as string, {
                        expand: ['payment_method'],
                    });
                    const pm = pi.payment_method as Stripe.PaymentMethod | null;
                    if (pm?.card) {
                        renewCardBrand      = pm.card.brand     || null;
                        renewCardLast4      = pm.card.last4      || null;
                        renewCardExpMonth   = pm.card.exp_month  || null;
                        renewCardExpYear    = pm.card.exp_year   || null;
                    }
                    renewCardPostalCode = pm?.billing_details?.address?.postal_code || null;
                }
            } catch (cardErr) {
                console.warn('[stripe-webhook] Could not retrieve card for renewal:', (cardErr as any)?.message);
            }

            // Record the renewal payment in our payments table
            const planRecord = await db.select({ id: plans.id, planName: plans.planName })
                .from(plans)
                .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
                .limit(1);

            if (planRecord.length > 0) {
                const plan = planRecord[0];
                await db.insert(payments).values({
                    userId,
                    planId: plan.id,
                    amount: invoice.amount_paid ? (invoice.amount_paid / 100).toFixed(2) : '0.00',
                    currency: (invoice.currency || 'gbp').toUpperCase(),
                    status: 'completed',
                    externalPaymentId: invoice.payment_intent as string || invoice.id,
                    description: `${plan.planName} — renewal`,
                    cardBrand:      renewCardBrand,
                    cardLast4:      renewCardLast4,
                    cardExpMonth:   renewCardExpMonth,
                    cardExpYear:    renewCardExpYear,
                    cardPostalCode: renewCardPostalCode,
                    paymentMethod:  renewCardBrand && renewCardLast4 ? `${renewCardBrand} ending ${renewCardLast4}` : null,
                }).catch(err => console.warn('[stripe-webhook] Duplicate payment insert skipped:', err.message));
            }

            // In-app notification: Subscription renewed
            if (billingReason === 'subscription_cycle') {
                await db.insert(notifications).values({
                    userId,
                    type: 'billing_renewed',
                    title: 'Subscription Renewed',
                    message: `Your subscription has been renewed successfully${amount ? ` — ${amount} charged` : ''}${periodEnd ? `. Active until ${periodEnd}.` : '.'}`,
                    isRead: false,
                    metadata: {
                        invoiceId: invoice.id,
                        amountPaid: invoice.amount_paid,
                        periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
                    },
                });
            } else {
                // Manual payment / other invoice paid
                await db.insert(notifications).values({
                    userId,
                    type: 'billing_payment_received',
                    title: 'Payment Received',
                    message: `A payment of ${amount || 'your invoice'} has been received and your account is up to date.`,
                    isRead: false,
                    metadata: {
                        invoiceId: invoice.id,
                        amountPaid: invoice.amount_paid,
                    },
                });
            }
        }
    }

    // ── invoice.payment_failed — declined card ────────────────────
    if (stripeEvent.type === 'invoice.payment_failed') {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        const userId  = await _resolveUserId(invoice.customer as string);
        if (userId) {
            const attemptCount = (invoice as any).attempt_count as number || 1;
            const amount       = invoice.amount_due ? `£${(invoice.amount_due / 100).toFixed(2)}` : '';
            const nextAttempt  = (invoice as any).next_payment_attempt as number | null;
            const nextTry      = nextAttempt
                ? new Date(nextAttempt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
                : null;

            const urgency = attemptCount >= 3
                ? 'Your subscription will be cancelled if payment is not received. '
                : nextTry ? `We will try again on ${nextTry}. ` : '';

            await db.insert(notifications).values({
                userId,
                type: 'billing_payment_failed',
                title: 'Payment Failed',
                message: `We were unable to charge ${amount || 'your account'} for your subscription. ${urgency}Please update your payment details to keep your assistants active.`,
                isRead: false,
                metadata: {
                    invoiceId: invoice.id,
                    amountDue: invoice.amount_due,
                    attemptCount,
                    nextPaymentAttempt: nextAttempt ? new Date(nextAttempt * 1000).toISOString() : null,
                },
            });

            // Also mark the plan as past_due in our DB
            await db.update(plans)
                .set({ status: 'past_due' })
                .where(and(eq(plans.userId, userId), eq(plans.status, 'active')));
        }
    }

    // ── customer.subscription.deleted — subscription cancelled ────
    if (stripeEvent.type === 'customer.subscription.deleted') {
        const sub    = stripeEvent.data.object as Stripe.Subscription;
        const userId = await _resolveUserIdFromSub(sub);
        if (userId) {
            // Mark plans as cancelled — covers both 'active' and 'cancelling' (set by billing-cancel.ts)
            await db.update(plans)
                .set({ status: 'cancelled' })
                .where(and(eq(plans.userId, userId), inArray(plans.status, ['active', 'cancelling'])));

            await db.insert(notifications).values({
                userId,
                type: 'billing_cancelled',
                title: 'Subscription Cancelled',
                message: 'Your subscription has been cancelled and your Digital Assistants have been deactivated. You can re-subscribe at any time from the Billing area.',
                isRead: false,
                metadata: { subscriptionId: sub.id },
            });
        }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve our internal userId from a Stripe customer ID.
 * Checks customer metadata first (auraUserId), then falls back to email lookup.
 */
async function _resolveUserId(customerId: string): Promise<number | null> {
    try {
        const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
        if (!customer || customer.deleted) return null;

        // Fast path: metadata set at checkout
        if (customer.metadata?.auraUserId) {
            return parseInt(customer.metadata.auraUserId);
        }

        // Fallback: email lookup in our DB
        if (customer.email) {
            const db = getDb();
            const [user] = await db.select({ id: users.id })
                .from(users).where(eq(users.email, customer.email));
            return user?.id ?? null;
        }
    } catch (err) {
        console.warn('[stripe-webhook] _resolveUserId failed:', (err as any)?.message);
    }
    return null;
}

/**
 * Resolve userId from a Stripe Subscription object.
 * Uses subscription metadata first, then falls back to customer lookup.
 */
async function _resolveUserIdFromSub(sub: Stripe.Subscription): Promise<number | null> {
    if (sub.metadata?.userId) return parseInt(sub.metadata.userId);
    return _resolveUserId(sub.customer as string);
}
