import { config } from 'dotenv';
import * as path from 'path';
import * as crypto from 'crypto'; // Native Node module for secure tokens

// Load .env from the root
config({ path: path.resolve(process.cwd(), '.env') });

import { Handler } from '@netlify/functions';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { users } from '../../db/schema'; // Assuming schema.ts is updated

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) {
    throw new Error("CRITICAL: NETLIFY_DATABASE_URL is missing.");
}

const sql = postgres(connectionString);
const db = drizzle({ client: sql });

export const handler: Handler = async (event) => {
    // Only accept POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const { email, firstName, lastName, businessName } = JSON.parse(event.body || '{}');
        if (!email) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Email is required.' }) };
        }

        // 1. Generate a secure random token and set expiration (e.g., 24 hours)
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        // 2. Insert the user as pending
        const [newUser] = await db.insert(users).values({
            email,
            firstName,
            lastName,
            companyName: businessName || null, // Persist here for cross-device retrieval
            status: 'pending_verification',
            verificationToken: crypto.randomBytes(32).toString('hex'),
            tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        }).returning();

        // 3. SEND THE EMAIL (Placeholder)
        // Here you would integrate your email provider.
        // e.g., await resend.emails.send({ to: email, subject: 'Verify your Aura account', html: `<a href="https://yourdomain.com/api/verify?token=${verificationToken}">Verify Email</a>` });
        console.log(`Simulated Email Sent to ${email} with token: ${verificationToken}`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Registration successful. Please check your email to verify your account.',
                userId: newUser.id
            }),
        };
    } catch (error: any) {
        console.error('Registration Error:', error);
        // Handle unique constraint violations (e.g., user already exists)
        if (error.code === '23505') {
            return { statusCode: 409, body: JSON.stringify({ error: 'An account with this email already exists.' }) };
        }
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to register user.' }) };
    }
};