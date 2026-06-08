import { Handler } from '@netlify/functions';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { payments, aiAssistants, onboardingDrafts, notifications } from '../../db/schema';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-05-27.dahlia' });
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!; // Add this to Netlify Envs

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const sig = event.headers['stripe-signature'];
    let stripeEvent;

    try {
        stripeEvent = stripe.webhooks.constructEvent(event.body!, sig!, webhookSecret);
    } catch (err: any) {
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    if (stripeEvent.type === 'checkout.session.completed') {
        const session = stripeEvent.data.object as any;
        const { userId, assistantId, paymentId } = session.metadata || {};

        if (userId && assistantId && paymentId) {
            const db = getDb();

            // 1. Mark Payment as Complete
            await db.update(payments).set({ status: 'completed', externalPaymentId: session.id })
                .where(eq(payments.id, parseInt(paymentId)));

            // 2. Mark Assistant as ready for Async AI Provisioning
            await db.update(aiAssistants).set({ provisioningStatus: 'pending', isActive: true })
                .where(eq(aiAssistants.id, parseInt(assistantId)));

            // 3. Clear the user's auto-save draft now that they have purchased
            await db.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, parseInt(userId)));

            // 4. Notify User
            await db.insert(notifications).values({
                userId: parseInt(userId),
                type: 'billing',
                title: 'Payment Successful',
                message: 'Your new Digital Assistant is currently being provisioned.',
                isRead: false
            });

            // 5. Trigger the Heavy Async AI Prompt processing!
            fetch(`${process.env.URL}/.netlify/functions/provision-assistant-async`, {
                method: 'POST',
                body: JSON.stringify({ assistantId: parseInt(assistantId) })
            }).catch(err => console.error("Async provisioning trigger failed:", err));
        }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
};