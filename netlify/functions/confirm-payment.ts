import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, payments, masterPlans, notifications } from '../../db/schema';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-05-27.dahlia' });
const jwtSecret = process.env.JWT_SECRET!;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        // 1. Auth
        const cookieHeader = event.headers.cookie || '';
        const match = cookieHeader.match(/aura_session=([^;]+)/);
        const token = match ? match[1] : null;
        if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

        let userId: number;
        try {
            const decoded = jwt.verify(token, jwtSecret) as { userId: number };
            userId = decoded.userId;
        } catch {
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session' }) };
        }

        const { paymentIntentId } = JSON.parse(event.body || '{}');
        if (!paymentIntentId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing paymentIntentId' }) };

        const db = getDb();

        // 2. Check if a plan already exists for this user (webhook may have already run)
        const [existingPlan] = await db
            .select({ id: plans.id })
            .from(plans)
            .where(and(eq(plans.userId, userId), eq(plans.status, 'active')))
            .limit(1);

        if (existingPlan) {
            return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyExists: true }) };
        }

        // 3. Retrieve the PaymentIntent from Stripe to verify it succeeded and get metadata
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (pi.status !== 'succeeded') {
            return { statusCode: 400, body: JSON.stringify({ error: `Payment not succeeded: ${pi.status}` }) };
        }

        const { organisationId, tier, masterPlanId, stripePriceId, stripeCustomerId } = pi.metadata || {};

        // Confirm the PaymentIntent belongs to this user
        if (parseInt(pi.metadata?.userId || '0') !== userId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'PaymentIntent does not belong to this user' }) };
        }

        const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };

        const orgIdInt = parseInt(organisationId);
        const masterPlanIdInt = masterPlanId ? parseInt(masterPlanId) : null;
        const amountGbp = pi.amount ? (pi.amount / 100).toFixed(2) : '0.00';

        // 4. Look up plan name
        let planName = tier ? `Aura-Assist (${tier})` : 'Aura-Assist Subscription';
        if (masterPlanIdInt) {
            const [mp] = await db.select().from(masterPlans).where(eq(masterPlans.id, masterPlanIdInt)).limit(1);
            if (mp) planName = mp.name;
        }

        // 5. Create Stripe subscription with saved payment method (if not already created by webhook)
        if (stripePriceId && pi.payment_method) {
            await stripe.subscriptions.create({
                customer: stripeCustomerId,
                items: [{ price: stripePriceId }],
                default_payment_method: pi.payment_method as string,
                billing_cycle_anchor: 'now',
                proration_behavior: 'none',
                metadata: { userId: userId.toString(), organisationId, tier: tier || '', masterPlanId: masterPlanId || '' },
            }).catch(err => console.error('Subscription creation in confirm-payment failed:', err.message));
        }

        // 6. Create plan record
        const [newPlan] = await db.insert(plans).values({
            userId,
            organisationId: orgIdInt,
            masterPlanId: masterPlanIdInt,
            planName,
            planType: 'subscription',
            status: 'active',
        }).returning();

        // 7. Create payment record
        await db.insert(payments).values({
            userId,
            organisationId: orgIdInt,
            planId: newPlan.id,
            masterPlanId: masterPlanIdInt,
            amount: amountGbp,
            currency: 'GBP',
            status: 'completed',
            externalPaymentId: pi.id,
            description: `${planName} — first payment`,
        });

        // 8. Notify user
        await db.insert(notifications).values({
            userId,
            type: 'billing',
            title: 'Payment Successful',
            message: 'Your subscription is active. Head to your dashboard to set up your Digital Assistant.',
            isRead: false,
        });

        return { statusCode: 200, body: JSON.stringify({ ok: true, alreadyExists: false }) };

    } catch (err: any) {
        console.error('confirm-payment error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Server error' }) };
    }
};
