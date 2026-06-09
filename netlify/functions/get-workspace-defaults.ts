import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { userProfiles } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const cookieHeader = event.headers.cookie || '';
    const token = cookieHeader.match(/aura_session=([^;]+)/)?.[1];
    if (!token || !jwtSecret) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let currentUserId: number;
    try {
        currentUserId = (jwt.verify(token, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    const [profile] = await db
        .select({ preferences: userProfiles.preferences })
        .from(userProfiles)
        .where(eq(userProfiles.userId, currentUserId))
        .limit(1);

    const prefs = (profile?.preferences as any) || {};

    return {
        statusCode: 200,
        body: JSON.stringify({
            assistantRules: prefs.assistantRules || [],
            brandProfile: prefs.brandProfile || null,
        }),
    };
};
