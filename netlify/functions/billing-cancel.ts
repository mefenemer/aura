// billing-cancel.ts
// POST { stripeSubscriptionId } → cancels at period end via Stripe
// Sets cancel_at_period_end: true (does NOT cancel immediately).

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';

const jwtSecret    = process.env.JWT_SECRET;
const stripeSecret = process.env.STRIPE_SECRET_KEY;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret)    return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    if (!stripeSecret) return { statusCode: 503, body: JSON.stringify({ error: 'Stripe is not configured.' }) };

    // ── Auth ──────────────────────────────────────────────────────
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(cookie, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { stripeSubscriptionId } = body;

    if (!stripeSubscriptionId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'stripeSubscriptionId is required.' }) };
    }

    try {
        const db = getDb();
        const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

        // Verify this subscription belongs to this user's Stripe customer
        const [user] = await db.select({ email: users.email })
            .from(users).where(eq(users.id, userId));
        if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

        const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);

        // Resolve the user's Stripe customer to verify ownership
        const byMeta = await stripe.customers.search({
            query: `metadata['auraUserId']:'${userId}'`,
            limit: 5,
        });
        let customerId: string | null = byMeta.data[0]?.id || null;
        if (!customerId && user.email) {
            const byEmail = await stripe.customers.list({ email: user.email, limit: 5 });
            customerId = byEmail.data[0]?.id || null;
        }

        if (!customerId || sub.customer !== customerId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Subscription does not belong to this account.' }) };
        }

        if (sub.status === 'canceled') {
            return { statusCode: 400, body: JSON.stringify({ error: 'Subscription is already cancelled.' }) };
        }

        // Set cancel at period end (graceful cancel — access continues until renewal date)
        const updated = await stripe.subscriptions.update(stripeSubscriptionId, {
            cancel_at_period_end: true,
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                cancelAtPeriodEnd: updated.cancel_at_period_end,
                currentPeriodEnd: updated.current_period_end,
            }),
        };

    } catch (err: any) {
        console.error('[billing-cancel]', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Failed to cancel subscription.' }) };
    }
};
