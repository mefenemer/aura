import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';
import { getDb } from '../../db/client'; // 👈 Protected connection pool
import { users } from '../../db/schema';
import { sendMagicLinkEmail } from '../../src/utils/email'; // 👈 Resend utility integration

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
                // Security: Generate a plain token for the user, and a hashed token for the DB
                const plainToken = crypto.randomBytes(32).toString('hex');
                const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');

                // Login links should have a shorter lifespan than registration links
                const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

                await db.update(users)
                    .set({ verificationToken: hashedToken, tokenExpiresAt })
                    .where(eq(users.id, user.id));

                // Construct the link and send the email
                // Dynamically determine the URL based on the incoming request headers
                const host = event.headers?.host || 'localhost:8888';
                const protocol = host.includes('localhost') ? 'http' : 'https';
                const baseUrl = `${protocol}://${host}`;

                // Send the PLAIN token in the email link
                const magicLink = `${baseUrl}/verify-account.html?token=${plainToken}`;
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

    return { statusCode: 405, body: 'Method Not Allowed' };
};