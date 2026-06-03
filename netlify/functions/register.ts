import { Handler } from '@netlify/functions';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client'; // 👈 Uses your new unified client utility!
import { users, organisations, userOrganisations } from '../../db/schema'; // Ensure you import related tables

// Small helper function to create safe URL slugs from company names
const slugify = (str: string) =>
    str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // Cleaned up double JSON.parse parsing
        const { email, firstName, lastName, businessName } = JSON.parse(event.body || '{}');
        if (!email) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Email is required.' }) };
        }

        const db = getDb();

        // 1. Generate a secure random token and expiration *exactly once*
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        // 2. Perform actions inside a Transaction to preserve data integrity across tables
        const resultUser = await db.transaction(async (tx) => {

            // A. Create the base pending user without the non-existent 'companyName' key
            const [newUser] = await tx.insert(users).values({
                email,
                firstName,
                lastName,
                status: 'pending_verification',
                verificationToken, // 👈 FIX: Matches the email token exactly
                tokenExpiresAt     // 👈 FIX: Matches the timestamp bound
            }).returning();

            // B. Handle Multi-Tenant context if a business name was provided
            if (businessName) {
                // Create the organization record
                const [newOrg] = await tx.insert(organisations).values({
                    name: businessName,
                    slug: `${slugify(businessName)}-${crypto.randomBytes(3).toString('hex')}` // Keeps slug unique
                }).returning();

                // Map user to the organization with a default role via junction table
                await tx.insert(userOrganisations).values({
                    userId: newUser.id,
                    organisationId: newOrg.id,
                    role: 'admin' // Set as admin/owner of their workspace
                });

                // Update user to hold reference to their default organisationId
                await tx.update(users)
                    .set({ organisationId: newOrg.id })
                    .where(eq(users.id, newUser.id));
            }

            return newUser;
        });

        // 3. SEND THE EMAIL (Placeholder)
        // Now verificationToken correctly matches what's stored in the DB row!
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