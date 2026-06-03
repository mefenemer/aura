import { Handler } from '@netlify/functions';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, organisations, userOrganisations } from '../../db/schema';
import { sendMagicLinkEmail } from '../../src/utils/email';

const slugify = (str: string) =>
    str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body || '{}');

        // 👈 FIX: Destructure and immediately normalize the email
        const rawEmail = body.email || '';
        const email = rawEmail.trim().toLowerCase();

        const { firstName, lastName, businessName } = body;

        if (!email) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Email is required.' }) };
        }

        const db = getDb();

        const verificationToken = crypto.randomBytes(32).toString('hex');
        const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const resultUser = await db.transaction(async (tx) => {
            const [newUser] = await tx.insert(users).values({
                email, // 👈 Now strictly lowercase
                firstName,
                lastName,
                status: 'pending_verification',
                verificationToken,
                tokenExpiresAt
            }).returning();

            if (businessName) {
                const [newOrg] = await tx.insert(organisations).values({
                    name: businessName,
                    slug: `${slugify(businessName)}-${crypto.randomBytes(3).toString('hex')}`
                }).returning();

                await tx.insert(userOrganisations).values({
                    userId: newUser.id,
                    organisationId: newOrg.id,
                    role: 'admin'
                });

                await tx.update(users)
                    .set({ organisationId: newOrg.id })
                    .where(eq(users.id, newUser.id));
            }

            return newUser;
        });
// 👈 NEW: Construct the link and send the email
        // Netlify injects process.env.URL in production automatically
        // Netlify provides DEPLOY_PRIME_URL for branch previews, and falls back to URL for production
        const baseUrl = process.env.DEPLOY_PRIME_URL || process.env.URL || 'http://localhost:8888';
        const magicLink = `${baseUrl}/.netlify/functions/verify?token=${verificationToken}`;

        await sendMagicLinkEmail({
            to: email,
            subject: 'Verify your Aura Assist Account',
            html: `
                <div style="font-family: sans-serif; text-align: center; padding: 40px 20px; background-color: #fdfcf9;">
                    <div style="max-width: 500px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 16px; border: 1px solid #eae4d7; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                        <h2 style="color: #1f1e1b; margin-top: 0;">Welcome to Aura Assist</h2>
                        <p style="color: #5c564b; font-size: 16px; line-height: 1.5;">Click the button below to securely verify your account and complete your workspace setup.</p>
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
                message: 'Registration successful. Please check your email to verify your account.',
                userId: resultUser.id
            }),
        };
    } catch (error: any) {
        console.error('Registration Error:', error);
        if (error.code === '23505') {
            return { statusCode: 409, body: JSON.stringify({ error: 'An account with this email already exists.' }) };
        }
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to register user.' }) };
    }
};