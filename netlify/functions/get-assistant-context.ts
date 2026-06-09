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

    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    const token = match ? match[1] : null;

    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let currentUserId: number;
    try {
        currentUserId = (jwt.verify(token, jwtSecret) as { userId: number }).userId;
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    const [assistant] = await db.select({
        id: aiAssistants.id,
        name: aiAssistants.name,
        role: aiAssistants.aiAssistantJobRole,
        status: aiAssistants.provisioningStatus,
        isActive: aiAssistants.isActive,
        onboardingContext: aiAssistants.onboardingContext,
        configuration: aiAssistants.configuration,
    }).from(aiAssistants)
        .where(and(eq(aiAssistants.id, parseInt(assistantId)), eq(aiAssistants.userId, currentUserId)))
        .limit(1);

    if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

    return { statusCode: 200, body: JSON.stringify({
            context: assistant.onboardingContext,
            configuration: assistant.configuration,
            name: assistant.name,
            role: assistant.role || 'Digital Assistant',
            status: assistant.status || 'pending',
            isActive: assistant.isActive,
        }) };
};