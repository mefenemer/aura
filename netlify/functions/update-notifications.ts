import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { userProfiles } from '../../db/schema';
import { eq } from 'drizzle-orm';

export const handler: Handler = async (event) => {
    const standardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    };

    const AUTHENTICATED_USER_ID = 1; // Workspace owner session mock context
    const db = getDb();

    // 1. Hydrate Toggles on Page Load
    if (event.httpMethod === 'GET') {
        try {
            const profile = await db.select().from(userProfiles).where(eq(userProfiles.userId, AUTHENTICATED_USER_ID)).limit(1);
            if (!profile.length) {
                return { statusCode: 404, headers: standardHeaders, body: JSON.stringify({ error: 'Profile not found.' }) };
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
            return { statusCode: 500, headers: standardHeaders, body: JSON.stringify({ error: 'Failed to load preferences.' }) };
        }
    }

    // 2. Background Auto-Save Updates
    if (event.httpMethod === 'PATCH') {
        try {
            if (!event.body) {
                return { statusCode: 400, headers: standardHeaders, body: JSON.stringify({ error: 'Missing configuration payload.' }) };
            }

            const { preferenceKey, value } = JSON.parse(event.body);

            // Restrict updates to valid notification columns only
            const validKeys = ['notifyWins', 'notifyBilling', 'notifyAvailability'];
            if (!validKeys.includes(preferenceKey) || typeof value !== 'boolean') {
                return { statusCode: 400, headers: standardHeaders, body: JSON.stringify({ error: 'Invalid preference key parameter.' }) };
            }

            // Build dynamic update allocation map
            const updatePayload: Record<string, boolean> = {};
            updatePayload[preferenceKey] = value;

            await db.update(userProfiles)
                .set(updatePayload)
                .where(eq(userProfiles.userId, AUTHENTICATED_USER_ID));

            return {
                statusCode: 200,
                headers: standardHeaders,
                body: JSON.stringify({ success: true, message: 'Preference auto-saved successfully.' })
            };

        } catch (error) {
            console.error('Notification background save failure:', error);
            return { statusCode: 500, headers: standardHeaders, body: JSON.stringify({ error: 'Database record modification exception.' }) };
        }
    }

    return { statusCode: 405, headers: standardHeaders, body: 'Method Not Allowed' };
};