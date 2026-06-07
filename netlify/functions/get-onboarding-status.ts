import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { userProfiles } from '../../db/schema'; // Removed unused 'users'

const jwtSecret = process.env.JWT_SECRET!;

export const handler: Handler = async (event) => {
    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    const token = match ? match[1] : null;
    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

    try {
        const decoded = jwt.verify(token, jwtSecret) as { userId: number };
        const db = getDb();

        const [profile] = await db.select()
            .from(userProfiles)
            .where(eq(userProfiles.userId, decoded.userId));

        // FIX: Cast preferences as 'any' or an interface to resolve TS2339
        const preferences = (profile?.preferences as any) || {};
        const isComplete = preferences.onboardingComplete;

        return {
            statusCode: 200,
            body: JSON.stringify({ isComplete, status: isComplete ? 100 : 50 })
        };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
    }
};