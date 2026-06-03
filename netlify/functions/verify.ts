// verify.ts
import { Handler } from '@netlify/functions';
import { eq, and, gt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import jwt from 'jsonwebtoken';

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
    throw new Error("CRITICAL: JWT_SECRET is missing.");
}

export const handler: Handler = async (event) => {
    // 1. ONLY accept POST requests now
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        // 2. Parse the token from the JSON body
        const body = JSON.parse(event.body || '{}');
        const token = body.token;

        if (!token) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Verification token is missing.' })
            };
        }

        const db = getDb();

        const [user] = await db.select()
            .from(users)
            .where(
                and(
                    eq(users.verificationToken, token),
                    gt(users.tokenExpiresAt, new Date())
                )
            )
            .limit(1);

        if (!user) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid or expired verification link.' })
            };
        }

        await db.update(users)
            .set({
                status: 'active',
                verificationToken: null,
                tokenExpiresAt: null,
            })
            .where(eq(users.id, user.id));

        const tokenPayload = {
            userId: user.id,
            email: user.email,
        };

        const signedToken = jwt.sign(tokenPayload, jwtSecret, { expiresIn: '7d' });

        // 3. Set the cookie and return a 200 OK JSON response
        const sessionCookie = `aura_session=${signedToken}; Path=/; Secure; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}`;

        return {
            statusCode: 200,
            headers: {
                'Set-Cookie': sessionCookie,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                success: true,
                redirect: '/onboarding.html'
            })
        };
    } catch (error) {
        console.error('Verification Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An internal error occurred.' })
        };
    }
};