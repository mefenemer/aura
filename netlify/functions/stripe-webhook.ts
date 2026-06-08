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

    // --- New flow: payment first, onboarding after ---
    // Fired when a subscription's first (or recurring) invoice is paid.
    if (stripeEvent.type === 'invoice.paid') {
        const invoice = stripeEvent.data.object as Stripe.Invoice;

        // Only process the first invoice (subscription creation), not renewals
        if (invoice.billing_reason !== 'subscription_create') {
            return { statusCode: 200, body: JSON.stringify({ received: true }) };
        }

        const subscriptionId = typeof invoice.subscription === 'string'
            ? invoice.subscription
            : (invoice.subscription as any)?.id;
        if (!subscriptionId) return { statusCode: 200, body: JSON.stringify({ received: true }) };

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const { userId, organisationId, tier, masterPlanId, assistantId } = subscription.metadata || {};

        if (!userId) return { statusCode: 200, body: JSON.stringify({ received: true }) };

        const db = getDb();
        const userIdInt = parseInt(userId);
        const orgIdInt = parseInt(organisationId);
        const amountGbp = invoice.amount_paid ? (invoice.amount_paid / 100).toFixed(2) : '0.00';

        // --- Post-payment onboarding flow (no assistantId in metadata yet) ---
        if (!assistantId) {
            const masterPlanIdInt = masterPlanId ? parseInt(masterPlanId) : null;

            // Look up masterPlan for the plan name
            let planName = tier ? `Aura-Assist (${tier})` : 'Aura-Assist Subscription';
            if (masterPlanIdInt) {
                const [mp] = await db.select().from(masterPlans).where(eq(masterPlans.id, masterPlanIdInt)).limit(1);
                if (mp) planName = mp.name;
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
                externalPaymentId: invoice.id,
                description: `${planName} — first payment`,
            });

            // Notify user to complete onboarding
            await db.insert(notifications).values({
                userId: userIdInt,
                type: 'billing',
                title: 'Payment Successful',
                message: 'Your subscription is active. Head to your dashboard to set up your Digital Assistant.',
                isRead: false,
            });

            return { statusCode: 200, body: JSON.stringify({ received: true }) };
        }

        // --- Legacy flow: assistantId present (old create-checkout-intent path) ---
        const paymentIdMeta = subscription.metadata?.paymentId;
        if (paymentIdMeta) {
            await db.update(payments).set({ status: 'completed', externalPaymentId: invoice.id })
                .where(eq(payments.id, parseInt(paymentIdMeta)));
        }

        await db.update(aiAssistants).set({ provisioningStatus: 'pending', isActive: true })
            .where(eq(aiAssistants.id, parseInt(assistantId)));

        await db.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, userIdInt));

        await db.insert(notifications).values({
            userId: userIdInt,
            type: 'billing',
            title: 'Payment Successful',
            message: 'Your new Digital Assistant is currently being provisioned.',
            isRead: false,
        });

        fetch(`${process.env.URL}/.netlify/functions/provision-assistant-async`, {
            method: 'POST',
            body: JSON.stringify({ assistantId: parseInt(assistantId) }),
        }).catch(err => console.error('Async provisioning trigger failed:', err));
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
