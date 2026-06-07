// netlify/functions/check-assistant-name.ts
import { HandlerEvent } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // 1. Authenticate Session
    const rawCookieHeader = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookieHeader.split(';').map(c => {
            const [key, ...v] = c.trim().split('=');
            return [key, decodeURIComponent(v.join('='))];
        }).filter(([key]) => key !== '')
    );

    const sessionToken = cookies['aura_session'];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        const decoded = jwt.verify(sessionToken, jwtSecret) as { userId: number };
        userId = decoded.userId;
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const name = event.queryStringParameters?.name;
    if (!name) return { statusCode: 400, body: JSON.stringify({ error: 'Name parameter is required.' }) };

    try {
        const db = getDb();

        // 2. Case-insensitive database check
        const existing = await db.select().from(aiAssistants)
            .where(and(
                eq(aiAssistants.userId, userId),
                sql`LOWER(${aiAssistants.name}) = LOWER(${name})`
            )).limit(1);

        return { statusCode: 200, body: JSON.stringify({ isUnique: existing.length === 0 }) };

    } catch (error) {
        console.error('Validation Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};