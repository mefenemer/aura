import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { users, userProfiles } from '../../db/schema';
import { eq, and, ne } from 'drizzle-orm';

export const handler: Handler = async (event) => {
    const standardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    };

    // Mocking the authenticated session user ID for this workspace instance
    const AUTHENTICATED_USER_ID = 1;
    const db = getDb();

    // --- SCENARIO 1: DYNAMIC DATA HYDRATION (GET) ---
    if (event.httpMethod === 'GET') {
        try {
            // Perform a clean SQL join to fetch base user details and metadata simultaneously
            const resultRows = await db
                .select({
                    id: users.id,
                    firstName: users.firstName,
                    lastName: users.lastName,
                    email: users.email,
                    timezone: userProfiles.timezone
                })
                .from(users)
                .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
                .where(eq(users.id, AUTHENTICATED_USER_ID))
                .limit(1);

            if (!resultRows.length) {
                return {
                    statusCode: 404,
                    headers: standardHeaders,
                    body: JSON.stringify({ error: 'User workspace records not found.' })
                };
            }

            return {
                statusCode: 200,
                headers: standardHeaders,
                body: JSON.stringify(resultRows[0])
            };
        } catch (error) {
            console.error('Profile hydration database error:', error);
            return {
                statusCode: 500,
                headers: standardHeaders,
                body: JSON.stringify({ error: 'Database connection failed during hydration.' })
            };
        }
    }

    // --- SCENARIOS 2 & 3: VALIDATION AND PERSISTENCE (PATCH) ---
    if (event.httpMethod === 'PATCH') {
        try {
            if (!event.body) {
                return {
                    statusCode: 400,
                    headers: standardHeaders,
                    body: JSON.stringify({ error: 'Missing modification payload.' })
                };
            }

            const { firstName, lastName, email, timezone } = JSON.parse(event.body);

            // 1. Completeness Validation
            if (!firstName || !lastName || !email || !timezone) {
                return {
                    statusCode: 400,
                    headers: standardHeaders,
                    body: JSON.stringify({ error: 'All profile and tracking fields are strictly required.' })
                };
            }

            // 2. Email Format Validation
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return {
                    statusCode: 422,
                    headers: standardHeaders,
                    body: JSON.stringify({ error: 'Invalid email address format.', field: 'email' })
                };
            }

            // 3. Email Uniqueness Verification (Exclude the current user session)
            const emailConflict = await db
                .select()
                .from(users)
                .where(and(eq(users.email, email), ne(users.id, AUTHENTICATED_USER_ID)))
                .limit(1);

            if (emailConflict.length > 0) {
                return {
                    statusCode: 409,
                    headers: standardHeaders,
                    body: JSON.stringify({ error: 'This email address is already associated with another active account.', field: 'email' })
                };
            }

            // 4. Atomic Multi-Table Update Transactions
            await db.transaction(async (tx) => {
                // Update primary user identification details
                await tx
                    .update(users)
                    .set({ firstName, lastName, email, updatedAt: new Date() })
                    .where(eq(users.id, AUTHENTICATED_USER_ID));

                // Update metadata preference details inside the separate profile table
                await tx
                    .update(userProfiles)
                    .set({ timezone })
                    .where(eq(userProfiles.userId, AUTHENTICATED_USER_ID));
            });

            return {
                statusCode: 200,
                headers: standardHeaders,
                body: JSON.stringify({ message: 'Profile and system preferences updated successfully.' })
            };

        } catch (error) {
            console.error('Profile mutation runtime rejection:', error);
            return {
                statusCode: 500,
                headers: standardHeaders,
                body: JSON.stringify({ error: 'Server could not process profile persistence updates safely.' })
            };
        }
    }

    return {
        statusCode: 405,
        headers: standardHeaders,
        body: 'Method Not Allowed'
    };
};