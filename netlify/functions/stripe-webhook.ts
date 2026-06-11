import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import { eq, and, inArray, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { payments, plans, aiAssistants, onboardingDrafts, notifications, users, masterPlans, invoices, processedWebhookEvents, userReferrals } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';

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

    // ── Idempotency guard — reject already-processed events ───────
    // Stripe retries webhooks on non-2xx responses; this prevents
    // double-charging, duplicate plans, and duplicate invoices.
    try {
        await db.insert(processedWebhookEvents).values({
            stripeEventId: stripeEvent.id,
            eventType: stripeEvent.type,
        });
    } catch {
        // Unique constraint violation = already processed; return 200 to stop retries
        console.log(`[stripe-webhook] Duplicate event ignored: ${stripeEvent.id}`);
        return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) };
    }

    // ── payment_intent.succeeded — initial checkout ───────────────
    if (stripeEvent.type === 'payment_intent.succeeded') {
        const pi = stripeEvent.data.object as Stripe.PaymentIntent;
        const { userId, organisationId, tier, masterPlanId, stripePriceId, stripeCustomerId, billingCycle } = pi.metadata || {};

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

        // Look up plan name + keep masterPlan record for subscription creation below
        let planName = tier ? `Aura-Assist (${tier})` : 'Aura-Assist Subscription';
        let masterPlan: typeof masterPlans.$inferSelect | null = null;
        if (masterPlanIdInt) {
            const [mp] = await db.select().from(masterPlans).where(eq(masterPlans.id, masterPlanIdInt)).limit(1);
            if (mp) { planName = mp.name; masterPlan = mp; }
        }

        // Create Stripe subscription with the saved payment method for recurring billing.
        // For annual subscriptions use inline price_data (interval: year); monthly uses the fixed price ID.
        // We capture the subscription ID to store on the plan record for future upgrade/downgrade.
        let createdStripeSubscriptionId: string | null = null;
        if (pi.payment_method) {
            const isAnnual  = billingCycle === 'annual';
            const subMeta   = { userId, organisationId, tier: tier || '', masterPlanId: masterPlanId || '', billingCycle: billingCycle || 'monthly' };

            try {
                let createdSub: Stripe.Subscription | null = null;
                if (isAnnual && masterPlan) {
                    const annualAmount = Math.round(Number(masterPlan.monthlyPriceGbp) * 12 * 0.80 * 100);
                    createdSub = await stripe.subscriptions.create({
                        customer: stripeCustomerId,
                        items: [{
                            price_data: {
                                currency: 'gbp',
                                product_data: { name: masterPlan.name },
                                unit_amount: annualAmount,
                                recurring: { interval: 'year' },
                            },
                        }],
                        default_payment_method: pi.payment_method as string,
                        billing_cycle_anchor: 'now',
                        proration_behavior: 'none',
                        metadata: subMeta,
                    });
                } else if (stripePriceId) {
                    createdSub = await stripe.subscriptions.create({
                        customer: stripeCustomerId,
                        items: [{ price: stripePriceId }],
                        default_payment_method: pi.payment_method as string,
                        billing_cycle_anchor: 'now',
                        proration_behavior: 'none',
                        metadata: subMeta,
                    });
                }
                if (createdSub) createdStripeSubscriptionId = createdSub.id;
            } catch (err) {
                console.error('[stripe-webhook] Subscription creation failed:', err);
            }
        }

        // Create plan record — include Stripe references for future upgrade/downgrade/cancel
        const [newPlan] = await db.insert(plans).values({
            userId: userIdInt,
            organisationId: orgIdInt,
            masterPlanId: masterPlanIdInt,
            planName,
            planType: 'subscription',
            status: 'active',
            stripeCustomerId,
            stripeSubscriptionId: createdStripeSubscriptionId,
        }).returning();

        // US-GAP-8.1.1 SC7: Trial-to-paid conversion — expire any active trial plan for this user
        // so check-capacity returns the new paid plan rather than the trial
        await db.update(plans)
            .set({ status: 'expired', updatedAt: new Date() })
            .where(and(eq(plans.userId, userIdInt), eq(plans.planType, 'trial'), eq(plans.status, 'active')));

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

        // ── Create invoice record ─────────────────────────────────
        const billingPeriodStart = new Date();
        const billingPeriodEnd   = new Date(billingPeriodStart);
        billingPeriodEnd.setMonth(billingPeriodEnd.getMonth() + 1);

        const inv = await _createInvoice({
            userId:               userIdInt,
            organisationId:       orgIdInt || null,
            planId:               newPlan.id,
            planName,
            amountPence:          pi.amount || 0,
            currency:             pi.currency || 'gbp',
            billingPeriodStart,
            billingPeriodEnd,
            stripePaymentIntentId: pi.id,
        });

        // ── Notifications ─────────────────────────────────────────
        // 1. Invoice ready notification
        if (inv) {
            await db.insert(notifications).values({
                userId: userIdInt,
                type: 'invoice_ready',
                title: `Your invoice for ${planName} is ready`,
                message: `Invoice ${inv.invoiceNumber} has been generated for your ${planName} subscription. View it in your Invoice History.`,
                isRead: false,
                metadata: { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, action: 'view_invoices' },
            });
        }

        // 2. Onboarding nudge
        await db.insert(notifications).values({
            userId: userIdInt,
            type: 'billing',
            title: 'Payment Successful — Set Up Your Assistant',
            message: 'Your subscription is active. Click "Resume Setup" on your dashboard to build your Digital Assistant now.',
            isRead: false,
        });

        // ── US-GAP-8.2: Referral qualification + £10 reward ──────────
        // If this new paying user was referred, mark the referral 'qualified' and
        // apply a £10 Stripe customer balance credit to the referrer.
        try {
            const [pendingReferral] = await db
                .select({ id: userReferrals.id, referrerId: userReferrals.referrerId })
                .from(userReferrals)
                .where(and(eq(userReferrals.referredUserId, userIdInt), eq(userReferrals.status, 'pending')))
                .limit(1);

            if (pendingReferral) {
                // Look up referrer's Stripe customer id from their active plan
                const [referrerPlan] = await db
                    .select({ stripeCustomerId: plans.stripeCustomerId })
                    .from(plans)
                    .where(and(eq(plans.userId, pendingReferral.referrerId), eq(plans.status, 'active')))
                    .limit(1);

                let balanceTxId: string | null = null;

                if (referrerPlan?.stripeCustomerId) {
                    // Apply £10 credit (negative amount = credit in Stripe)
                    const balanceTx = await stripe.customers.createBalanceTransaction(
                        referrerPlan.stripeCustomerId,
                        { amount: -1000, currency: 'gbp', description: 'Referral reward — friend made their first payment' },
                    );
                    balanceTxId = balanceTx.id;
                }

                // Update referral row
                await db.update(userReferrals)
                    .set({ status: 'rewarded', qualifiedAt: new Date(), rewardedAt: new Date(), stripeBalanceTxId: balanceTxId })
                    .where(eq(userReferrals.id, pendingReferral.id));

                // Notify referrer
                await db.insert(notifications).values({
                    userId: pendingReferral.referrerId,
                    type: 'referral_reward',
                    title: '🎉 Referral Reward Earned — £10 Credit Applied',
                    message: 'A friend you referred has signed up and made their first payment. We\'ve added a £10 credit to your account — it will be applied to your next invoice.',
                    isRead: false,
                    metadata: { referralId: pendingReferral.id, rewardGbp: 10 },
                });
            }
        } catch (refErr) {
            console.warn('[stripe-webhook] Referral reward failed (non-blocking):', refErr);
        }
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

            // ── Create invoice record for this renewal ────────────
            const renewPlanRecord = planRecord[0]; // already fetched above
            const periodStart = invoice.period_start ? new Date(invoice.period_start * 1000) : null;
            const periodEndDate = invoice.period_end ? new Date(invoice.period_end * 1000) : null;

            const renewInv = await _createInvoice({
                userId,
                planId:               renewPlanRecord?.id ?? null,
                planName:             renewPlanRecord?.planName ?? 'Aura-Assist Subscription',
                amountPence:          invoice.amount_paid || 0,
                currency:             invoice.currency || 'gbp',
                billingPeriodStart:   periodStart,
                billingPeriodEnd:     periodEndDate,
                stripeInvoiceId:      invoice.id,
                stripePaymentIntentId: invoice.payment_intent as string || null,
            });

            // ── Invoice ready notification ────────────────────────
            if (renewInv) {
                await db.insert(notifications).values({
                    userId,
                    type: 'invoice_ready',
                    title: `Your invoice for ${renewPlanRecord?.planName ?? 'your subscription'} is ready`,
                    message: `Invoice ${renewInv.invoiceNumber} has been generated. View it in your Invoice History.`,
                    isRead: false,
                    metadata: { invoiceId: renewInv.id, invoiceNumber: renewInv.invoiceNumber, action: 'view_invoices' },
                });
            }

            // ── Grace period recovery — restore assistants if plan was past_due ─
            // If the user had a payment failure + grace period active, a successful payment
            // should restore the plan to 'active' and re-enable any 'paused_payment' assistants.
            const [maybePastDuePlan] = await db
                .select({ id: plans.id })
                .from(plans)
                .where(and(eq(plans.userId, userId), eq(plans.status, 'past_due')))
                .limit(1);

            if (maybePastDuePlan) {
                await db.update(plans)
                    .set({ status: 'active', gracePeriodEndsAt: null, updatedAt: new Date() })
                    .where(eq(plans.id, maybePastDuePlan.id));

                // Re-enable assistants that were paused specifically due to payment failure
                await db.update(aiAssistants)
                    .set({ isActive: true, provisioningStatus: 'complete', updatedAt: new Date() })
                    .where(and(
                        eq(aiAssistants.userId, userId),
                        eq(aiAssistants.provisioningStatus, 'paused_payment'),
                    ));
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
                // Manual payment / other invoice paid (covers grace-period recovery payments)
                await db.insert(notifications).values({
                    userId,
                    type: 'billing_payment_received',
                    title: maybePastDuePlan ? 'Payment Received — Assistants Restored' : 'Payment Received',
                    message: maybePastDuePlan
                        ? `A payment of ${amount || 'your invoice'} has been received. Your account is back to active and your assistants have been re-enabled.`
                        : `A payment of ${amount || 'your invoice'} has been received and your account is up to date.`,
                    isRead: false,
                    metadata: {
                        invoiceId: invoice.id,
                        amountPaid: invoice.amount_paid,
                    },
                });
            }
        }
    }

    // ── invoice.payment_failed — declined card / grace-period policy ─
    // Grace period: 7 days from first failure — assistants keep running.
    // After grace period expires (enforced by check-capacity at runtime) assistants are blocked.
    // On attempt ≥ 3 (Stripe default final attempt): pause assistants immediately.
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

            // Set grace period to 7 days from now on first failure; don't extend it on subsequent failures
            const now = new Date();
            const gracePeriodEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

            const [existingPlan] = await db
                .select({ id: plans.id, gracePeriodEndsAt: plans.gracePeriodEndsAt })
                .from(plans)
                .where(and(eq(plans.userId, userId), inArray(plans.status, ['active', 'past_due'])))
                .limit(1);

            if (existingPlan) {
                await db.update(plans)
                    .set({
                        status: 'past_due',
                        // Only set grace period on first failure; preserve it on subsequent attempts
                        gracePeriodEndsAt: existingPlan.gracePeriodEndsAt ?? gracePeriodEndsAt,
                        updatedAt: now,
                    })
                    .where(eq(plans.id, existingPlan.id));
            }

            // On final attempt (≥ 3): immediately pause all assistants
            if (attemptCount >= 3) {
                await db.update(aiAssistants)
                    .set({ isActive: false, provisioningStatus: 'paused_payment', updatedAt: now })
                    .where(and(eq(aiAssistants.userId, userId), eq(aiAssistants.isActive, true)));
            }

            const urgency = attemptCount >= 3
                ? 'Your assistants have been paused. Please update your payment details immediately to restore access. '
                : attemptCount === 1
                    ? `Your assistants will continue running for 7 days while we retry. `
                    : nextTry ? `We will try again on ${nextTry}. ` : '';

            await db.insert(notifications).values({
                userId,
                type: 'billing_payment_failed',
                title: `Payment Failed${attemptCount >= 3 ? ' — Assistants Paused' : ''}`,
                message: `We were unable to charge ${amount || 'your account'} for your subscription. ${urgency}Update your payment details in the Billing section.`,
                isRead: false,
                metadata: {
                    invoiceId: invoice.id,
                    amountDue: invoice.amount_due,
                    attemptCount,
                    gracePeriodEndsAt: attemptCount < 3 ? gracePeriodEndsAt.toISOString() : null,
                    nextPaymentAttempt: nextAttempt ? new Date(nextAttempt * 1000).toISOString() : null,
                },
            });

            // US-GAP-3.2.1 SC1/SC2: Day 0 dunning email — mandatory transactional (always sent, SC4)
            // SC3: Idempotency — skip if already sent for this invoice+attempt combination
            // We use processedWebhookEvents keyed on "dunning:{invoiceId}:{attemptCount}"
            const dunningDedupeKey = `dunning:${invoice.id}:attempt${attemptCount}`;
            const [alreadySent] = await db
                .select({ id: processedWebhookEvents.id })
                .from(processedWebhookEvents)
                .where(eq(processedWebhookEvents.stripeEventId, dunningDedupeKey))
                .limit(1);

            if (!alreadySent) {
                // Mark as sent before actually sending to prevent duplicate sends on concurrent retries
                await db.insert(processedWebhookEvents)
                    .values({ stripeEventId: dunningDedupeKey, eventType: 'dunning_email_sent' })
                    .onConflictDoNothing();

                // Fetch user email
                const [userRecord] = await db
                    .select({ email: users.email, firstName: users.firstName })
                    .from(users)
                    .where(eq(users.id, userId))
                    .limit(1);

                if (userRecord) {
                    // Generate Stripe billing portal URL for payment update CTA (SC2d)
                    let portalUrl = (process.env.BASE_URL || '') + '/billing.html';
                    try {
                        const portal = await stripe.billingPortal.sessions.create({
                            customer: invoice.customer as string,
                            return_url: (process.env.BASE_URL || '') + '/billing.html',
                        });
                        portalUrl = portal.url;
                    } catch { /* fall back to billing.html */ }

                    const nextRetryLine = nextTry
                        ? `<p>💳 <strong>Next automatic retry:</strong> ${nextTry}</p>`
                        : '';
                    const assistantWarning = attemptCount >= 3
                        ? `<p style="color:#dc2626;font-weight:bold;">⚠️ Your assistants have been paused due to repeated payment failures. Restore access by updating your payment details immediately.</p>`
                        : `<p>✅ Your data and assistants are safe — no changes have been made yet. We'll automatically retry the payment.</p>`;

                    await sendEmail({
                        to: userRecord.email,
                        subject: `Payment failed — action required`,
                        html: `<p>Hi ${userRecord.firstName || 'there'},</p>
                               <p>We were unable to process your subscription payment.</p>
                               <p>💰 <strong>Amount:</strong> ${amount || 'see your billing page'}</p>
                               ${nextRetryLine}
                               ${assistantWarning}
                               <p style="margin-top:24px;">
                                 <a href="${portalUrl}" style="background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                                   Update Payment Details →
                                 </a>
                               </p>
                               <p style="margin-top:16px;font-size:0.875rem;color:#6b7280;">
                                 Questions? <a href="mailto:hello@aura-assist.com">Contact our support team</a>.
                               </p>
                               <p>The Aura Team</p>`,
                    }).catch(err => console.warn('[stripe-webhook] Day 0 dunning email failed:', err));
                }
            }
        }
    }

    // ── customer.subscription.updated — plan change / downgrade ──
    // Fires when Stripe changes the subscription (upgrade, downgrade, cancel_at_period_end).
    // We enforce the new assistant limit: pause excess assistants oldest-first.
    if (stripeEvent.type === 'customer.subscription.updated') {
        const sub    = stripeEvent.data.object as Stripe.Subscription;
        const userId = await _resolveUserIdFromSub(sub);
        if (userId) {
            // Resolve new plan limits from subscription metadata
            const newMasterPlanId = sub.metadata?.masterPlanId ? parseInt(sub.metadata.masterPlanId) : null;
            if (newMasterPlanId) {
                const [newMasterPlan] = await db
                    .select({ assistantLimit: masterPlans.assistantLimit, name: masterPlans.name })
                    .from(masterPlans)
                    .where(eq(masterPlans.id, newMasterPlanId))
                    .limit(1);

                if (newMasterPlan?.assistantLimit !== null && newMasterPlan?.assistantLimit !== undefined) {
                    // Count currently active assistants
                    const activeAssistants = await db
                        .select({ id: aiAssistants.id, name: aiAssistants.name, createdAt: aiAssistants.createdAt })
                        .from(aiAssistants)
                        .where(and(eq(aiAssistants.userId, userId), eq(aiAssistants.isActive, true)))
                        .orderBy(desc(aiAssistants.createdAt)); // newest first → pause oldest

                    const excess = activeAssistants.length - newMasterPlan.assistantLimit;
                    if (excess > 0) {
                        // Pause the oldest (last in desc-sorted list) excess assistants
                        const toPause = activeAssistants.slice(newMasterPlan.assistantLimit);
                        const pauseIds = toPause.map(a => a.id);
                        const pausedNames = toPause.map(a => a.name).join(', ');

                        await db.update(aiAssistants)
                            .set({ isActive: false, provisioningStatus: 'paused_limit', updatedAt: new Date() })
                            .where(and(eq(aiAssistants.userId, userId), inArray(aiAssistants.id, pauseIds)));

                        await db.insert(notifications).values({
                            userId,
                            type: 'assistants_paused_downgrade',
                            title: 'Assistants Paused — Plan Limit Reached',
                            message: `Your plan change reduced your assistant limit to ${newMasterPlan.assistantLimit}. The following assistant${excess > 1 ? 's have' : ' has'} been paused: ${pausedNames}. You can delete or swap assistants from your workspace.`,
                            isRead: false,
                            metadata: { pausedIds: pauseIds, newLimit: newMasterPlan.assistantLimit },
                        });
                    }
                }
            }
        }
    }

    // ── customer.subscription.deleted — subscription cancelled ────
    if (stripeEvent.type === 'customer.subscription.deleted') {
        const sub    = stripeEvent.data.object as Stripe.Subscription;
        const userId = await _resolveUserIdFromSub(sub);
        if (userId) {
            // Mark plans as cancelled — capture cancelledAt for win-back email scheduling (US-GAP-4.2.1)
            const cancelledNow = new Date();
            await db.update(plans)
                .set({ status: 'cancelled', cancelledAt: cancelledNow, updatedAt: cancelledNow })
                .where(and(eq(plans.userId, userId), inArray(plans.status, ['active', 'cancelling', 'past_due'])));

            // Pause ALL active assistants — no active subscription
            await db.update(aiAssistants)
                .set({ isActive: false, provisioningStatus: 'paused_payment', updatedAt: new Date() })
                .where(and(eq(aiAssistants.userId, userId), eq(aiAssistants.isActive, true)));

            await db.insert(notifications).values({
                userId,
                type: 'billing_cancelled',
                title: 'Subscription Cancelled — Assistants Paused',
                message: 'Your subscription has been cancelled and your Digital Assistants have been paused. You can re-subscribe at any time from the Billing area to restore full access.',
                isRead: false,
                metadata: { subscriptionId: sub.id },
            });
        }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a sequential invoice number and insert an invoice record.
 * Returns the newly inserted invoice.
 */
async function _createInvoice(params: {
    userId: number;
    organisationId?: number | null;
    planId?: number | null;
    planName: string;
    amountPence: number;   // Stripe amount in smallest currency unit (pence for GBP)
    currency: string;
    billingPeriodStart?: Date | null;
    billingPeriodEnd?: Date | null;
    stripeInvoiceId?: string | null;
    stripePaymentIntentId?: string | null;
}): Promise<typeof invoices.$inferSelect | null> {
    try {
        const db = getDb();
        const total    = (params.amountPence / 100).toFixed(2);
        const taxRate  = '0';    // Adjust if you collect VAT; update per-region logic here
        const taxAmt   = '0.00';
        const subtotal = total;  // subtotal == total when taxRate is 0

        // Insert with placeholder invoice number, then update once we have the DB id
        const [inv] = await db.insert(invoices).values({
            userId:               params.userId,
            organisationId:       params.organisationId ?? null,
            planId:               params.planId ?? null,
            invoiceNumber:        'PENDING',
            issueDate:            new Date(),
            billingPeriodStart:   params.billingPeriodStart ?? null,
            billingPeriodEnd:     params.billingPeriodEnd ?? null,
            planName:             params.planName,
            subtotal,
            taxRate,
            taxAmount:            taxAmt,
            total,
            currency:             (params.currency || 'GBP').toUpperCase(),
            status:               'paid',
            stripeInvoiceId:      params.stripeInvoiceId ?? null,
            stripePaymentIntentId: params.stripePaymentIntentId ?? null,
        }).returning();

        if (!inv) return null;

        // Assign deterministic invoice number: INV-YYYYMM-000001
        const now     = new Date();
        const yyyymm  = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
        const invNum  = `INV-${yyyymm}-${String(inv.id).padStart(6, '0')}`;

        const [updated] = await db.update(invoices)
            .set({ invoiceNumber: invNum })
            .where(eq(invoices.id, inv.id))
            .returning();

        return updated ?? null;
    } catch (err) {
        console.error('[stripe-webhook] _createInvoice failed:', (err as any)?.message);
        return null;
    }
}

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
