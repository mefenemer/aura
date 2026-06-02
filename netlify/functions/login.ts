import { config } from 'dotenv';
import * as path from 'path';

// Load .env
config({ path: path.resolve(process.cwd(), '.env') });

import { Handler } from '@netlify/functions';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';
import { users } from '../../db/schema'; // Adjust path if necessary

const connectionString = process.env.NETLIFY_DATABASE_URL;

if (!connectionString) {
    throw new Error("CRITICAL: NETLIFY_DATABASE_URL is missing.");
}

const sql = postgres(connectionString);
const db = drizzle({ client: sql });

export const handler: Handler = async (event) => {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { email } = JSON.parse(event.body || '{}');

        if (!email) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Email is required.' }) };
        }

        const normalizedEmail = email.trim().toLowerCase();

        // 1. Look up the user
        const [existingUser] = await db.select()
            .from(users)
            .where(eq(users.email, normalizedEmail))
            .limit(1);

        // 2. Anti-Enumeration Security
        // If the user does NOT exist, we silently exit but still return a 200 OK
        // to the frontend so attackers can't guess valid emails.
        if (!existingUser) {
            console.log(`[AUTH LOG] Login attempt for non-existent email: ${normalizedEmail}`);
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'If an account exists, an email has been sent.' })
            };
        }

        // 3. Generate a fresh Magic Link Token
        const loginToken = crypto.randomBytes(32).toString('hex');
        // Token is valid for 1 hour
        const tokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);

        // 4. Update the user record with the new token
        await db.update(users)
            .set({
                verificationToken: loginToken,
                tokenExpiresAt: tokenExpiresAt
            })
            .where(eq(users.id, existingUser.id));

        // 5. Simulate Email Sending (To be replaced with Resend/SendGrid)
        // The link points to the verify endpoint we already built
        const magicLink = `${process.env.URL || 'http://localhost:8888'}/.netlify/functions/verify?token=${loginToken}&email=${encodeURIComponent(normalizedEmail)}`;

        console.log('\n---------------------------------------------------------');
        console.log('✉️  SIMULATED LOGIN EMAIL');
        console.log(`To: ${normalizedEmail}`);
        console.log(`Subject: Log in to Aura`);
        console.log(`Body: Click here to log in securely:\n${magicLink}`);
        console.log('---------------------------------------------------------\n');

        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'If an account exists, an email has been sent.' })
        };

    } catch (error) {
        console.error('Login error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An internal server error occurred.' })
        };
    }
};