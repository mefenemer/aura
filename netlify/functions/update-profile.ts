import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { users, userProfiles } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { logAuditEvent } from '../../src/utils/audit';

export const handler: Handler = async (event) => {
    const standardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    };

    const AUTHENTICATED_USER_ID = 1;

    try {
        const db = getDb();

        // Hydration logic
        if (event.httpMethod === 'GET') {
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

            if (!resultRows.length) return { statusCode: 404, headers: standardHeaders, body: JSON.stringify({ error: 'User not found.' }) };
            return { statusCode: 200, headers: standardHeaders, body: JSON.stringify(resultRows[0]) };
        }

        // Auto-Save logic
        if (event.httpMethod === 'PATCH') {
            if (!event.body) return { statusCode: 400, headers: standardHeaders, body: JSON.stringify({ error: 'Missing body payload.' }) };
            const { fieldKey, value } = JSON.parse(event.body);

            if (fieldKey === 'firstName' || fieldKey === 'lastName' || fieldKey === 'email') {
                const updateObject: Record<string, any> = {};
                updateObject[fieldKey] = value;
                await db.update(users).set(updateObject).where(eq(users.id, AUTHENTICATED_USER_ID));
            } else if (fieldKey === 'timezone') {
                const profileCheck = await db.select().from(userProfiles).where(eq(userProfiles.userId, AUTHENTICATED_USER_ID)).limit(1);
                if (!profileCheck.length) {
                    await db.insert(userProfiles).values({
                        userId: AUTHENTICATED_USER_ID,
                        timezone: value,
                        notifyWins: true,
                        notifyBilling: true,
                        notifyAvailability: false
                    });
                } else {
                    await db.update(userProfiles).set({ timezone: value }).where(eq(userProfiles.userId, AUTHENTICATED_USER_ID));
                }
            }

            return { statusCode: 200, headers: standardHeaders, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, headers: standardHeaders, body: 'Method Not Allowed' };
    } catch (error: any) {
        // EXPLICIT ERROR PASSTHROUGH: Sends the exact database rejection message to the frontend
        console.error('Profile update rejection:', error);
        return { statusCode: 500, headers: standardHeaders, body: JSON.stringify({ error: error.message || 'Database execution failed.' }) };
    }
};
// ... after successfully updating the database:
logAuditEvent({
    userId: currentUser.id,
    actionType: 'UPDATE',
    resourceType: 'user_profiles',
    resourceId: currentUser.id,
    previousState: oldProfileData,
    newState: updatedProfileData,
    ipAddress: event.headers['client-ip'] || event.headers['x-forwarded-for'],
    userAgent: event.headers['user-agent']
});