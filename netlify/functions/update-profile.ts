// netlify/functions/update-profile.ts
import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { users, userProfiles } from '../../db/schema';
import { eq } from 'drizzle-orm';

export const handler: Handler = async (event) => {
    const standardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    };

    const AUTHENTICATED_USER_ID = 1;
    const db = getDb();

    // GET: Hydrate all fields simultaneously via Join
    if (event.httpMethod === 'GET') {
        try {
            const resultRows = await db
                .select({
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
                return { statusCode: 404, headers: standardHeaders, body: JSON.stringify({ error: 'User not found.' }) };
            }
            return { statusCode: 200, headers: standardHeaders, body: JSON.stringify(resultRows[0]) };
        } catch (error) {
            return { statusCode: 500, headers: standardHeaders, body: JSON.stringify({ error: 'Hydration failure.' }) };
        }
    }

    // PATCH: Modern Auto-Save processing block
    if (event.httpMethod === 'PATCH') {
        try {
            if (!event.body) return { statusCode: 400, headers: standardHeaders, body: 'Missing body' };
            const { fieldKey, value } = JSON.parse(event.body);

            // Route fields cleanly to their respective destination tables
            if (fieldKey === 'firstName' || fieldKey === 'lastName' || fieldKey === 'email') {
                const updateObject: Record<string, any> = {};
                updateObject[fieldKey] = value;

                await db.update(users).set(updateObject).where(eq(users.id, AUTHENTICATED_USER_ID));
            } else if (fieldKey === 'timezone') {
                await db.update(userProfiles).set({ timezone: value }).where(eq(userProfiles.userId, AUTHENTICATED_USER_ID));
            }

            return { statusCode: 200, headers: standardHeaders, body: JSON.stringify({ success: true }) };
        } catch (e) {
            return { statusCode: 500, headers: standardHeaders, body: JSON.stringify({ error: 'Auto-save failed.' }) };
        }
    }

    return { statusCode: 405, headers: standardHeaders, body: 'Method Not Allowed' };
};