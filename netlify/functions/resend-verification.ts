import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';
import { getDb } from '../../db/client'; // 👈 Unified client utility applied
import { users } from '../../db/schema';
import { sendMagicLinkEmail } from '../../src/utils/email'; // 👈 Resend utility integration

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body || '{}');

        if (!body.email) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Email is required.' }) };
        }

        // Normalize the email to prevent silent case-mismatch failures
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
        const newTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        // 3. Update the user record
        await db.update(users)
            .set({
                verificationToken: newVerificationToken,
                tokenExpiresAt: newTokenExpiresAt,
            })
            .where(eq(users.id, existingUser.id));

        // 4. Construct the link and send the email
// Netlify provides DEPLOY_PRIME_URL for branch previews, and falls back to URL for production
// Dynamically determine the URL based on the incoming request headers
        const host = event.headers?.host || 'localhost:8888';
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const baseUrl = `${protocol}://${host}`;

// NEW
// NEW
        const magicLink = `${baseUrl}/verify-account.html?token=${newVerificationToken}`;
        await sendMagicLinkEmail({
            to: email,
            subject: 'Your New Aura Assist Verification Link',
            html: `
                <div style="font-family: sans-serif; text-align: center; padding: 40px 20px; background-color: #fdfcf9;">
                    <div style="max-width: 500px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 16px; border: 1px solid #eae4d7; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                        <h2 style="color: #1f1e1b; margin-top: 0;">Verify your Account</h2>
                        <p style="color: #5c564b; font-size: 16px; line-height: 1.5;">You requested a new verification link. Click the button below to securely verify your account and complete your workspace setup.</p>
                        <a href="${magicLink}" style="background-color: #00e55c; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; margin: 24px 0; font-weight: bold; font-size: 16px;">
                            Verify Account
                        </a>
                        <p style="color: #787263; font-size: 14px; margin-bottom: 0;">This secure link expires in 24 hours.</p>
                    </div>
                </div>
            `
        });

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