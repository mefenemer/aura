import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { payments, aiAssistants, onboardingDrafts, notifications, users } from '../../db/schema';

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

    // Handle subscription-based (Elements) flow: invoice.paid
    if (stripeEvent.type === 'invoice.paid') {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
        if (!subscriptionId) return { statusCode: 200, body: JSON.stringify({ received: true }) };

        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const { userId, assistantId, paymentId } = subscription.metadata || {};

        if (userId && assistantId && paymentId) {
            const db = getDb();
            const userIdInt = parseInt(userId);

            await db.update(payments).set({ status: 'completed', externalPaymentId: invoice.id })
                .where(eq(payments.id, parseInt(paymentId)));

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
    }

    if (stripeEvent.type === 'checkout.session.completed') {
        const session = stripeEvent.data.object as any;
        const { userId, assistantId, paymentId } = session.metadata || {};

        if (!userId) {
            console.error('Webhook: missing userId in session metadata', session.id);
            return { statusCode: 200, body: JSON.stringify({ received: true }) };
        }

        const db = getDb();
        const userIdInt = parseInt(userId);

        if (assistantId && paymentId) {
            // --- Onboarding flow (onboarding.ts created the checkout) ---
            // All three IDs are present: update existing records.

            // 1. Mark Payment as Complete
            await db.update(payments).set({ status: 'completed', externalPaymentId: session.id })
                .where(eq(payments.id, parseInt(paymentId)));

            // 2. Mark Assistant as ready for Async AI Provisioning
            await db.update(aiAssistants).set({ provisioningStatus: 'pending', isActive: true })
                .where(eq(aiAssistants.id, parseInt(assistantId)));

            // 3. Clear the user's auto-save draft now that they have purchased
            await db.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, userIdInt));

            // 4. Notify User
            await db.insert(notifications).values({
                userId: userIdInt,
                type: 'billing',
                title: 'Payment Successful',
                message: 'Your new Digital Assistant is currently being provisioned.',
                isRead: false
            });

            // 5. Trigger Async AI Prompt processing
            fetch(`${process.env.URL}/.netlify/functions/provision-assistant-async`, {
                method: 'POST',
                body: JSON.stringify({ assistantId: parseInt(assistantId) })
            }).catch(err => console.error("Async provisioning trigger failed:", err));

        } else {
            // --- Verify flow (verify.ts created the checkout with priceId) ---
            // No assistant or payment record exists yet; create the payment record
            // and notify the user. The assistant is created during onboarding.

            const [user] = await db.select().from(users).where(eq(users.id, userIdInt)).limit(1);
            const amountGbp = session.amount_total ? (session.amount_total / 100).toFixed(2) : '0.00';

            await db.insert(payments).values({
                userId: userIdInt,
                organisationId: user?.organisationId ?? null,
                amount: amountGbp,
                currency: 'GBP',
                status: 'completed',
                externalPaymentId: session.id,
                description: 'Aura-Assist Subscription'
            });

            await db.insert(notifications).values({
                userId: userIdInt,
                type: 'billing',
                title: 'Payment Successful',
                message: 'Your subscription is active. Complete your onboarding to set up your Digital Assistant.',
                isRead: false
            });
        }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
};