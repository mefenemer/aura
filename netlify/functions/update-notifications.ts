import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client'; // Adjust path if necessary
import { userProfiles } from '../../db/schema'; // Adjust path if necessary
import { eq } from 'drizzle-orm';

export const handler: Handler = async (event) => {
    const standardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    };

    const AUTHENTICATED_USER_ID = 1; // Workspace owner session mock context
    const db = getDb();

    // --- 1. HYDRATE TOGGLES ON PAGE LOAD (GET) ---
    if (event.httpMethod === 'GET') {
        try {
            const profile = await db
                .select()
                .from(userProfiles)
                .where(eq(userProfiles.userId, AUTHENTICATED_USER_ID))
                .limit(1);

            // FAILSAFE: If no notification preference row exists yet, create it instantly
            if (!profile.length) {
                const newProfile = await db.insert(userProfiles).values({
                    userId: AUTHENTICATED_USER_ID,
                    timezone: 'Europe/Athens',
                    notifyWins: true,
                    notifyBilling: true,
                    notifyAvailability: false
                }).returning();

                return {
                    statusCode: 200,
                    headers: standardHeaders,
                    body: JSON.stringify({
                        notifyWins: newProfile[0].notifyWins,
                        notifyBilling: newProfile[0].notifyBilling,
                        notifyAvailability: newProfile[0].notifyAvailability
                    })
                };
            }

            return {
                statusCode: 200,
                headers: standardHeaders,
                body: JSON.stringify({
                    notifyWins: profile[0].notifyWins,
                    notifyBilling: profile[0].notifyBilling,
                    notifyAvailability: profile[0].notifyAvailability
                })
            };
        } catch (error) {
            console.error('Notification GET crash:', error);
            return {
                statusCode: 500,
                headers: standardHeaders,
                body: JSON.stringify({ error: 'Failed to read notification profile from database.' })
            };
        }
    }

    // --- 2. BACKGROUND AUTO-SAVE UPDATES (PATCH) ---
    if (event.httpMethod === 'PATCH') {
        try {
            if (!event.body) {
                return { statusCode: 400, headers: standardHeaders, body: JSON.stringify({ error: 'Missing payload.' }) };
            }

            const { preferenceKey, value } = JSON.parse(event.body);

            // Strict column constraint whitelist validation
            const validKeys = ['notifyWins', 'notifyBilling', 'notifyAvailability'];
            if (!validKeys.includes(preferenceKey) || typeof value !== 'boolean') {
                return { statusCode: 400, headers: standardHeaders, body: JSON.stringify({ error: 'Invalid preference selector attribute.' }) };
            }

            // Verify if the profile row physically exists before patching it
            const profileCheck = await db
                .select()
                .from(userProfiles)
                .where(eq(userProfiles.userId, AUTHENTICATED_USER_ID))
                .limit(1);

            if (!profileCheck.length) {
                // FIXED: Explicitly typed inline map matching the Drizzle inferInsert format to eliminate TS2769
                const baseInsert = {
                    userId: AUTHENTICATED_USER_ID,
                    timezone: 'Europe/Athens',
                    notifyWins: preferenceKey === 'notifyWins' ? value : true,
                    notifyBilling: preferenceKey === 'notifyBilling' ? value : true,
                    notifyAvailability: preferenceKey === 'notifyAvailability' ? value : false
                };

                await db.insert(userProfiles).values(baseInsert);
            } else {
                // Standard atomic column save using bracket notation for mapping updates dynamically
                const updatePayload: Record<string, boolean> = {};
                updatePayload[preferenceKey] = value;

                await db
                    .update(userProfiles)
                    .set(updatePayload)
                    .where(eq(userProfiles.userId, AUTHENTICATED_USER_ID));
            }

            return {
                statusCode: 200,
                headers: standardHeaders,
                body: JSON.stringify({ success: true, message: 'Preferences updated.' })
            };

        } catch (error) {
            console.error('Notification PATCH crash:', error);
            return {
                statusCode: 500,
                headers: standardHeaders,
                body: JSON.stringify({ error: 'Database mutation exception occurred.' })
            };
        }
    }

    return {
        statusCode: 405,
        headers: standardHeaders,
        body: 'Method Not Allowed'
    };
};