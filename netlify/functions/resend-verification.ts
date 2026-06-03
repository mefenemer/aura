import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';
import { getDb } from '../../db/client'; // 👈 Unified client utility applied
import { users } from '../../db/schema';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body || '{}');

        if (!body.email) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Email is required.' }) };
        }

        // 👈 FIX: Normalize the email to prevent silent case-mismatch failures
        const email = body.email.trim().toLowerCase();
        const db = getDb();

        // 1. Find the user by normalized email
        const [existingUser] = await db.select()
            .from(users)
            .where(eq(users.email, email))
            .limit(1);

        if (!existingUser) {
            return { statusCode: 200, body: JSON.stringify({ message: 'If an account exists, a new link has been sent.' }) };
        }

        if (existingUser.status === 'active') {
            return { statusCode: 400, body: JSON.stringify({ error: 'This account is already verified. Please sign in.' }) };
        }

        // 2. Generate a new secure token and expiration
        const newVerificationToken = crypto.randomBytes(32).toString('hex');
        const newTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        // 3. Update the user record
        await db.update(users)
            .set({
                verificationToken: newVerificationToken,
                tokenExpiresAt: newTokenExpiresAt,
            })
            .where(eq(users.id, existingUser.id));

        // 4. SEND THE EMAIL (Placeholder)
        console.log(`Simulated RESEND Email to ${email} with new token: ${newVerificationToken}`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'A new verification link has been sent to your email.'
            }),
        };
    } catch (error) {
        console.error('Resend Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to resend verification email.' }) };
    }
};