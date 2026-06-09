// verify.ts
import { Handler, HandlerResponse } from '@netlify/functions';
import { eq, and, gt } from 'drizzle-orm';
import * as crypto from 'crypto';
import { getDb } from '../../db/client';
import { users, plans } from '../../db/schema';
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

        // Map Stripe price IDs → tier keys (test + live environments)
        const priceToTier: Record<string, string> = {
            // Test price IDs
            'price_1TgGNFE7lvVYjk1BAsnhUzBp': 'buster',
            'price_1TgGP8E7lvVYjk1BRBeEZVd6': 'saver',
            'price_1TgGPfE7lvVYjk1B1CQrS6pE': 'employee',
            // Live price IDs
            'price_1Tg6f1CuS8qyNSsFxeUsfi4a': 'buster',
            'price_1Tg6fQCuS8qyNSsF5DKmEqMu': 'saver',
            'price_1Tg6fiCuS8qyNSsF787zwCwh': 'employee',
        };

        // If no priceId — this is a returning user logging in (not a new registration).
        // Check if they already have an active plan; if so send them to the workspace.
        // If not (edge case: registered but never paid), send them back to pricing.
        if (!priceId || !priceToTier[priceId]) {
            const [existingPlan] = await db
                .select({ id: plans.id })
                .from(plans)
                .where(and(eq(plans.userId, user.id), eq(plans.status, 'active')))
                .limit(1);

            const destination = existingPlan
                ? `${baseUrl}/workspace.html`
                : `${baseUrl}/pricing.html?verified=true`;

            return {
                statusCode: 200,
                headers: getHeaders(sessionCookie),
                body: JSON.stringify({ success: true, redirect: destination })
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