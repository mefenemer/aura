import { Handler } from '@netlify/functions';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, organisations, userOrganisations } from '../../db/schema';

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

        console.log(`Simulated Email Sent to ${email} with token: ${verificationToken}`);

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