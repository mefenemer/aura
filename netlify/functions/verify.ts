// verify.ts
import { Handler, HandlerResponse } from '@netlify/functions';
import { eq, and, gt } from 'drizzle-orm';
import * as crypto from 'crypto';
import { getDb } from '../../db/client';
import { users, plans, aiAssistants, onboardingDrafts } from '../../db/schema';
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

        // Onboarding path → HTML page map (mirrors onboarding-reminder.ts)
        const ONBOARDING_PAGE: Record<string, string> = {
            'social-media':  'onboarding-social-media.html',
            'social_media':  'onboarding-social-media.html',
            'custom':        'onboarding-custom.html',
            'inventory':     'onboarding-inventory.html',
            'performance':   'onboarding-performance.html',
        };

        // If no priceId — this is a returning user logging in (not a new registration).
        // Priority:  active plan + incomplete onboarding → resume onboarding step
        //            active plan + complete onboarding   → workspace
        //            no plan                             → pricing
        if (!priceId || !priceToTier[priceId]) {
            const [existingPlan] = await db
                .select({ id: plans.id })
                .from(plans)
                .where(and(eq(plans.userId, user.id), eq(plans.status, 'active')))
                .limit(1);

            if (!existingPlan) {
                return {
                    statusCode: 200,
                    headers: getHeaders(sessionCookie),
                    body: JSON.stringify({ success: true, redirect: `${baseUrl}/pricing.html?verified=true` })
                };
            }

            // Has an active plan — check whether onboarding is complete
            const [assistant] = await db
                .select({ id: aiAssistants.id })
                .from(aiAssistants)
                .where(eq(aiAssistants.userId, user.id))
                .limit(1);

            if (!assistant) {
                // Incomplete onboarding — route back to the exact step they left off
                const [draft] = await db
                    .select({ currentStep: onboardingDrafts.currentStep, onboardingPath: onboardingDrafts.onboardingPath })
                    .from(onboardingDrafts)
                    .where(eq(onboardingDrafts.userId, user.id))
                    .limit(1);

                if (draft) {
                    const page = ONBOARDING_PAGE[draft.onboardingPath] || 'onboarding.html';
                    return {
                        statusCode: 200,
                        headers: getHeaders(sessionCookie),
                        body: JSON.stringify({
                            success: true,
                            redirect: `${baseUrl}/${page}?step=${draft.currentStep}&resumed=true`
                        })
                    };
                }
            }

            return {
                statusCode: 200,
                headers: getHeaders(sessionCookie),
                body: JSON.stringify({ success: true, redirect: `${baseUrl}/workspace.html` })
            };
        }

        const tierKey = priceToTier[priceId];
        return {
            statusCode: 200,
            headers: getHeaders(sessionCookie),
            body: JSON.stringify({ success: true, redirect: `${baseUrl}/checkout.html?tier=${tierKey}` })
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