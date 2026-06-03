// verify.ts
import { Handler } from '@netlify/functions';
import { eq, and, gt } from 'drizzle-orm';
import { getDb } from '../../db/client'; // 👈 No more duplicate config initialization!
import { users } from '../../db/schema';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const token = event.queryStringParameters?.token;
        if (!token) {
            return { statusCode: 400, body: 'Verification token is missing.' };
        }

        const db = getDb();

        // 1. Find user with an active, valid token window
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
            return { statusCode: 400, body: 'Invalid or expired verification link.' };
        }

        // 2. Consume token and transition account to active
        await db.update(users)
            .set({
                status: 'active',
                verificationToken: null,
                tokenExpiresAt: null,
            })
            .where(eq(users.id, user.id));

        const sessionCookie = `aura_session=simulated_jwt_for_user_${user.id}; Path=/; HttpOnly; Secure; SameSite=Strict`;

        return {
            statusCode: 302,
            headers: {
                'Location': '/onboarding.html',
                'Set-Cookie': sessionCookie
            },
        };
    } catch (error) {
        console.error('Verification Error:', error);
        return { statusCode: 500, body: 'An internal error occurred during verification.' };
    }
};