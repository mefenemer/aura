import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { payments, plans, aiAssistants, onboardingDrafts, notifications, users, masterPlans } from '../../db/schema';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-05-27.dahlia' });
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const sig = event.headers['stripe-signature'];
    let stripeEvent;

    try {
        stripeEvent = stripe.webhooks.constructEvent(event.body!, sig!, webhookSecret);
    } catch (err: any) {
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    // --- New flow: PaymentIntent paid → create subscription + DB records ---
    if (stripeEvent.type === 'payment_intent.succeeded') {
        const pi = stripeEvent.data.object as Stripe.PaymentIntent;
        const { userId, organisationId, tier, masterPlanId, stripePriceId, stripeCustomerId } = pi.metadata || {};

        // Only handle payment intents created by our checkout flow (they have userId in metadata)
        if (!userId || !stripeCustomerId) {
            return { statusCode: 200, body: JSON.stringify({ received: true }) };
        }

        const db = getDb();
        const userIdInt = parseInt(userId);
        const orgIdInt = parseInt(organisationId);
        const masterPlanIdInt = masterPlanId ? parseInt(masterPlanId) : null;
        const amountGbp = pi.amount ? (pi.amount / 100).toFixed(2) : '0.00';

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

        // Create payment record
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

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
