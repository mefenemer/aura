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

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: getHeaders(),
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const jwtSecret = process.env.JWT_SECRET;
        const stripeSecret = process.env.STRIPE_SECRET_KEY;

        if (!jwtSecret || !stripeSecret) {
            console.error('CRITICAL: JWT_SECRET or STRIPE_SECRET_KEY env var is missing.');
            return {
                statusCode: 500,
                headers: getHeaders(),
                body: JSON.stringify({ error: 'Server configuration error. Please contact support.' })
            };
        }

        const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });
        const body = JSON.parse(event.body || '{}');
        const { token: plainToken, priceId } = body;

        if (!plainToken) {
            return {
                statusCode: 400,
                headers: getHeaders(),
                body: JSON.stringify({ error: 'Verification token is required.' })
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

        // Map Stripe price IDs to onboarding tier keys
        const priceToTier: Record<string, string> = {
            'price_1Tg6f1CuS8qyNSsFxeUsfi4a': 'buster',
            'price_1Tg6fQCuS8qyNSsF5DKmEqMu': 'saver',
            'price_1Tg6fiCuS8qyNSsF787zwCwh': 'employee',
        };

        // If no priceId (e.g. link opened in a different browser), send them to
        // the pricing page to re-select their plan. The page detects ?verified=true
        // and skips registration — sending them straight to onboarding instead.
        if (!priceId || !priceToTier[priceId]) {
            return {
                statusCode: 200,
                headers: getHeaders(sessionCookie),
                body: JSON.stringify({ success: true, redirect: `${baseUrl}/pricing.html?verified=true` })
            };
        }

        const tierKey = priceToTier[priceId];
        return {
            statusCode: 200,
            headers: getHeaders(sessionCookie),
            body: JSON.stringify({ success: true, redirect: `${baseUrl}/onboarding-social-media.html?tier=${tierKey}` })
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