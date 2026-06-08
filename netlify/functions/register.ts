// netlify/functions/register.ts
import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import * as crypto from 'crypto';
import { getDb } from '../../db/client';
import { users, organisations, userOrganisations, userProfiles } from '../../db/schema'; // <-- Added userProfiles
import { sendMagicLinkEmail } from '../../src/utils/email';

const slugify = (str: string) =>
    str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body || '{}');

        const rawEmail = body.email || '';
        const email = rawEmail.trim().toLowerCase();
        const firstName = body.firstName?.trim();
        const lastName = body.lastName?.trim();
        const businessName = body.businessName?.trim() || `${firstName}'s Workspace`;

        if (!email || !firstName || !lastName) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields.' }) };
        }

        const db = getDb();

        // --- SCENARIO 5: ENUMERATION PROTECTION ---
        // Check if user already exists BEFORE doing anything else
        const existingUsers = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (existingUsers.length > 0) {
            // Silently return success to the UI to prevent scraping, do not create a duplicate
            console.log(`[Security] Blocked duplicate registration attempt for: ${email}`);
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // Generate Security Tokens (15 min expiry per AC)
        const plainToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
        const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

        // --- SCENARIO 2: NEW REGISTRATION & DATA CAPTURE ---
        const resultUser = await db.transaction(async (tx) => {

            // 1. Create User
            const [newUser] = await tx.insert(users).values({
                email,
                firstName,
                lastName,
                status: 'pending_verification',
                verificationToken: hashedToken, // Save the HASHED token
                tokenExpiresAt
            }).returning();

            // 2. Create Organization
            const [newOrg] = await tx.insert(organisations).values({
                name: businessName,
                slug: `${slugify(businessName)}-${crypto.randomBytes(3).toString('hex')}`
            }).returning();

            // 3. Link User to Organization
            await tx.insert(userOrganisations).values({
                userId: newUser.id,
                organisationId: newOrg.id,
                role: 'owner' // Upgraded to owner
            });

            // 4. Update User with Org ID
            await tx.update(users)
                .set({ organisationId: newOrg.id })
                .where(eq(users.id, newUser.id));

            // 5. Create default User Profile (Crucial for Account Settings hydration)
            await tx.insert(userProfiles).values({
                userId: newUser.id,
                timezone: 'Europe/London', // Baseline timezone
                notifyWins: true,
                notifyBilling: true,
                notifyAvailability: false
            });

            return newUser;
        });

        // Send the First-Time Verification Email
        const host = event.headers?.host || 'localhost:8888';
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const baseUrl = `${protocol}://${host}`;
        const magicLink = `${baseUrl}/verify-account.html?token=${plainToken}`;

        await sendMagicLinkEmail({
            to: email,
            subject: 'Welcome to Aura Assist - Verify your email',
            html: `
                <div style="font-family: sans-serif; text-align: center; padding: 40px 20px; background-color: #fdfcf9;">
                    <div style="max-width: 500px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 16px; border: 1px solid #eae4d7; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                        <h2 style="color: #1f1e1b; margin-top: 0;">Welcome, ${firstName}!</h2>
                        <p style="color: #5c564b; font-size: 16px; line-height: 1.5;">Click the button below to securely verify your account and complete your workspace setup.</p>
                        <a href="${magicLink}" style="background-color: #00e55c; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; margin: 24px 0; font-weight: bold; font-size: 16px;">
                            Verify & Log In
                        </a>
                        <p style="color: #787263; font-size: 14px; margin-bottom: 0;">This secure link expires in 15 minutes.</p>
                    </div>
                </div>
            `
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: 'Registration processed.' }),
        };
    } catch (error: any) {
        console.error('Registration Error Details:', error);
        // Log the actual error object, not just the string
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message || 'Failed to process registration.' })
        };
    }
};