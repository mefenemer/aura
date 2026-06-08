// verify.ts
import { Handler, HandlerResponse } from '@netlify/functions';
import { eq, and, gt } from 'drizzle-orm';
import * as crypto from 'crypto';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';

// Define a helper to ensure type safety for headers
const getHeaders = (cookie?: string): Record<string, string> => {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json'
    };
    if (cookie) {
        headers['Set-Cookie'] = cookie;
    }
    return headers;
};

const jwtSecret = process.env.JWT_SECRET;
const stripeSecret = process.env.STRIPE_SECRET_KEY;

if (!jwtSecret || !stripeSecret) {
    throw new Error("CRITICAL: Environment variables missing.");
}

const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: getHeaders(),
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const { token: plainToken, priceId } = body;

        if (!plainToken || !priceId) {
            return {
                statusCode: 400,
                headers: getHeaders(),
                body: JSON.stringify({ error: 'Token and priceId are required.' })
            };
        }

        const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
        const db = getDb();

        const [user] = await db.select()
            .from(users)
            .where(and(eq(users.verificationToken, hashedToken), gt(users.tokenExpiresAt, new Date())))
            .limit(1);

        if (!user) {
            return {
                statusCode: 400,
                headers: getHeaders(),
                body: JSON.stringify({ error: 'Invalid or expired verification link.' })
            };
        }

        await db.update(users)
            .set({ status: 'active', verificationToken: null, tokenExpiresAt: null })
            .where(eq(users.id, user.id));

        const tokenPayload = { userId: user.id, email: user.email };
        const signedToken = jwt.sign(tokenPayload, jwtSecret, { expiresIn: '7d' });
        const sessionCookie = `aura_session=${signedToken}; Path=/; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`;

        const protocol = event.headers['x-forwarded-proto'] || 'https';
        const baseUrl = `${protocol}://${event.headers.host}`;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            customer_email: user.email,
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'subscription',
            success_url: `${baseUrl}/dashboard-content.html?payment=success`,
            cancel_url: `${baseUrl}/pricing.html`,
            metadata: { userId: user.id.toString() }
        });

        return {
            statusCode: 200,
            headers: getHeaders(sessionCookie),
            body: JSON.stringify({ success: true, redirect: session.url })
        };
    } catch (error: any) {
        console.error('Verification/Stripe Error:', error);
        return {
            statusCode: 500,
            headers: getHeaders(),
            body: JSON.stringify({ error: error.message || 'An internal error occurred.' })
        };
    }
};