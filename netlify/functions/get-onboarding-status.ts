import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET!;

export const handler: Handler = async (event) => {
    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    const token = match ? match[1] : null;
    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

    try {
        const decoded = jwt.verify(token, jwtSecret) as { userId: number };
        const db = getDb();

        // Onboarding is complete once the user has at least one AI assistant set up.
        // This is reliable — the old check used preferences.onboardingComplete which
        // was never written by any function, so it always returned undefined.
        const [assistant] = await db
            .select({ id: aiAssistants.id })
            .from(aiAssistants)
            .where(eq(aiAssistants.userId, decoded.userId))
            .limit(1);

        const isComplete = !!assistant;

        return {
            statusCode: 200,
            body: JSON.stringify({ isComplete, status: isComplete ? 100 : 0 })
        };
    } catch (e) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
    }
};
