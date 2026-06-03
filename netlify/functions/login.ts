import { Handler } from '@netlify/functions';
import { eq, and, gt } from 'drizzle-orm';
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client'; // 👈 Protected connection pool
import { users } from '../../db/schema';
import { sendMagicLinkEmail } from '../../src/utils/email'; // 👈 Resend utility integration

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
    throw new Error("CRITICAL: JWT_SECRET is missing.");
}

export const handler: Handler = async (event) => {
    const db = getDb();

    // -------------------------------------------------------------
    // POST: Request a Magic Link (Triggered by login.html)
    // -------------------------------------------------------------
    if (event.httpMethod === 'POST') {
        try {
            const body = JSON.parse(event.body || '{}');
            const email = body.email?.trim().toLowerCase(); // 👈 Prevents case-sensitivity bugs

            if (!email) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Email is required.' }) };
            }

            // Find the active user
            const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

            if (user && user.status === 'active') {
                const magicLinkToken = crypto.randomBytes(32).toString('hex');
                // Login links should have a shorter lifespan than registration links
                const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

                await db.update(users)
                    .set({ verificationToken: magicLinkToken, tokenExpiresAt })
                    .where(eq(users.id, user.id));

                // Construct the link and send the email
                // Netlify provides DEPLOY_PRIME_URL for branch previews, and falls back to URL for production
                const baseUrl = process.env.DEPLOY_PRIME_URL || process.env.URL || 'http://localhost:8888';
                const magicLink = `${baseUrl}/.netlify/functions/login?token=${magicLinkToken}`;

                await sendMagicLinkEmail({
                    to: email,
                    subject: 'Log In to Aura Assist',
                    html: `
                        <div style="font-family: sans-serif; text-align: center; padding: 40px 20px; background-color: #fdfcf9;">
                            <div style="max-width: 500px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 16px; border: 1px solid #eae4d7; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                                <h2 style="color: #1f1e1b; margin-top: 0;">Welcome Back</h2>
                                <p style="color: #5c564b; font-size: 16px; line-height: 1.5;">Click the button below to securely log into your Aura Assist dashboard.</p>
                                <a href="${magicLink}" style="background-color: #00e55c; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; margin: 24px 0; font-weight: bold; font-size: 16px;">
                                    Log In to Dashboard
                                </a>
                                <p style="color: #787263; font-size: 14px; margin-bottom: 0;">This secure link expires in 15 minutes.</p>
                            </div>
                        </div>
                    `
                });
            }

            // Always return 200 to prevent bad actors from checking which emails exist
            return { statusCode: 200, body: JSON.stringify({ message: 'If an account exists, a link was sent.' }) };
        } catch (error) {
            console.error('Login Request Error:', error);
            return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error.' }) };
        }
    }

    // -------------------------------------------------------------
    // GET: Consume Magic Link & Issue JWT (Clicked from Email)
    // -------------------------------------------------------------
    if (event.httpMethod === 'GET') {
        try {
            const token = event.queryStringParameters?.token;
            if (!token) return { statusCode: 400, body: 'Verification token is missing.' };

            const [user] = await db.select()
                .from(users)
                .where(and(eq(users.verificationToken, token), gt(users.tokenExpiresAt, new Date())))
                .limit(1);

            if (!user) {
                return { statusCode: 400, body: 'Invalid or expired magic link. Please request a new one.' };
            }

            // Clear the token so it can't be reused
            await db.update(users)
                .set({ verificationToken: null, tokenExpiresAt: null })
                .where(eq(users.id, user.id));

            // Issue the Authentication JWT
            const signedToken = jwt.sign({ userId: user.id, email: user.email }, jwtSecret, { expiresIn: '7d' });
            const sessionCookie = `aura_session=${signedToken}; Path=/; Secure; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}`;

            return {
                statusCode: 302,
                headers: {
                    'Location': '/dashboard.html', // 👈 Redirects to dashboard, not onboarding
                    'Set-Cookie': sessionCookie
                },
            };
        } catch (error) {
            console.error('Login Verification Error:', error);
            return { statusCode: 500, body: 'An internal error occurred.' };
        }
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};