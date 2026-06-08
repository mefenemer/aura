import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const assistantId = event.queryStringParameters?.id;
    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'Assistant ID required.' }) };

    // 1. JWT Authentication Block
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    const token = match ? match[1] : null;

    if (!token) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    let currentUserId: number;
    try {
        const decoded = jwt.verify(token, jwtSecret) as { userId: number };
        currentUserId = decoded.userId;
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    // 2. Fetch Context Data
    const db = getDb();

    // Fetch the assistant, ensuring it belongs to the active user
    const [assistant] = await db.select({
        id: aiAssistants.id,
        name: aiAssistants.name,
        onboardingContext: aiAssistants.onboardingContext
    }).from(aiAssistants)
        .where(and(eq(aiAssistants.id, parseInt(assistantId)), eq(aiAssistants.userId, currentUserId)))
        .limit(1);

    if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

    // SCENARIO 4: Return the JSON object for frontend hydration
    return { statusCode: 200, body: JSON.stringify({ context: assistant.onboardingContext }) };
};