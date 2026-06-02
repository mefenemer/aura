import { config } from 'dotenv';
import * as path from 'path';

// Load .env from the root
config({ path: path.resolve(process.cwd(), '.env') });

import { Handler } from '@netlify/functions';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, and, gt } from 'drizzle-orm';
import { users } from '../../db/schema';
import jwt from 'jsonwebtoken';

const connectionString = process.env.NETLIFY_DATABASE_URL;
const jwtSecret = process.env.JWT_SECRET;

if (!connectionString) {
    throw new Error("CRITICAL: NETLIFY_DATABASE_URL is missing.");
}

if (!jwtSecret) {
    throw new Error("CRITICAL: JWT_SECRET is missing. Please add it to your .env and Netlify dashboard.");
}

const sql = postgres(connectionString);
const db = drizzle({ client: sql });

export const handler: Handler = async (event) => {
    // Only accept GET requests for magic links
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // Extract the token from the query string (e.g., ?token=abc123xyz)
        const token = event.queryStringParameters?.token;

        if (!token) {
            return { statusCode: 400, body: 'Verification token is missing.' };
        }

        // 1. Find the user with this token where the expiration is in the future
        const [user] = await db.select()
            .from(users)
            .where(
                and(
                    eq(users.verificationToken, token),
                    gt(users.tokenExpiresAt, new Date()) // Token must be greater than current time
                )
            )
            .limit(1);

        if (!user) {
            // Token is either invalid, expired, or already used
            return {
                statusCode: 400,
                body: 'Invalid or expired verification link. Please request a new one.'
            };
        }

        // 2. Update the user to 'active' and clear the token payload
        await db.update(users)
            .set({
                status: 'active',
                verificationToken: null,
                tokenExpiresAt: null,
            })
            .where(eq(users.id, user.id));

        // 3. Issue Authentication (Secure JWT)
        const tokenPayload = {
            userId: user.id,
            email: user.email,
        };

        // Sign the token (Valid for 7 days)
        const signedToken = jwt.sign(tokenPayload, jwtSecret, { expiresIn: '7d' });

        // NOTE: HttpOnly is removed so frontend JS can read it for routing
        const sessionCookie = `aura_session=${signedToken}; Path=/; Secure; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}`;

        // 4. Redirect the user straight into the onboarding workflow
        return {
            statusCode: 302, // HTTP redirect
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