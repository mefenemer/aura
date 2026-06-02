import { config } from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto';

// Load .env from the root
config({ path: path.resolve(process.cwd(), '.env') });

import { Handler } from '@netlify/functions';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema'; // Ensure path is correct

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) {
    throw new Error("CRITICAL: NETLIFY_DATABASE_URL is missing.");
}

const sql = postgres(connectionString);
const db = drizzle({ client: sql });

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const { email } = body;

        if (!email) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Email is required.' }) };
        }

        // 1. Find the user by email
        const [existingUser] = await db.select()
            .from(users)
            .where(eq(users.email, email))
            .limit(1);

        if (!existingUser) {
            // For security, do not reveal if the email exists or not to prevent enumeration attacks.
            // Just return a generic success message.
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
        // e.g., await resend.emails.send({ ... });
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