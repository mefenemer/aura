import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections } from '../../db/schema';
import { encryptCredential } from '../../src/utils/encryption';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    // 1. Session Authentication
    const cookieHeader = event.headers.cookie || '';
    const sessionToken = cookieHeader.match(/aura_session=([^;]+)/)?.[1];

    if (!sessionToken || !jwtSecret) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let currentUserId: number;
    try {
        currentUserId = (jwt.verify(sessionToken, jwtSecret) as { userId: number }).userId;
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    try {
        // --- GET: FETCH INTEGRATIONS DASHBOARD (Scenario 1) ---
        if (event.httpMethod === 'GET') {
            const connections = await db.select({
                id: systemConnections.id,
                serviceName: systemConnections.serviceName,
                connectionType: systemConnections.connectionType,
                externalUserId: systemConnections.externalUserId,
                status: systemConnections.status,
                updatedAt: systemConnections.updatedAt
            })
                .from(systemConnections)
                .where(eq(systemConnections.userId, currentUserId));

            // NOTE: accessToken (password/key) is INTENTIONALLY omitted from the SELECT statement.
            // It is never transmitted back to the client.
            return { statusCode: 200, body: JSON.stringify({ connections }) };
        }

        // --- POST: SECURE CONNECTION CREATION ---
        if (event.httpMethod === 'POST') {
            const body = JSON.parse(event.body || '{}');
            const { serviceName, connectionType, apiKey, username, password } = body;

            let encryptedToken = null;
            let externalId = null;

            if (connectionType === 'api_key') {
                if (!apiKey) return { statusCode: 400, body: JSON.stringify({ error: 'API Key required.' }) };
                encryptedToken = encryptCredential(apiKey);
                externalId = 'API Key';
            } else if (connectionType === 'legacy') {
                if (!username || !password) return { statusCode: 400, body: JSON.stringify({ error: 'Credentials required.' }) };
                encryptedToken = encryptCredential(password);
                externalId = username; // Safe to store username in plain text
            } else {
                return { statusCode: 400, body: JSON.stringify({ error: 'OAuth flows require dedicated redirect handlers.' }) };
            }

            await db.insert(systemConnections).values({
                userId: currentUserId,
                serviceName,
                connectionType,
                accessToken: encryptedToken, // Stored Encrypted Only
                externalUserId: externalId,
                status: 'active',
                isActive: true
            });

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // --- DELETE: SECURE DATA PURGE (Scenario 3) ---
        if (event.httpMethod === 'DELETE') {
            const connectionId = event.queryStringParameters?.id;
            if (!connectionId) return { statusCode: 400, body: JSON.stringify({ error: 'Connection ID required.' }) };

            // Hard delete ensures tokens are permanently removed from the database
            await db.delete(systemConnections)
                .where(and(
                    eq(systemConnections.id, parseInt(connectionId)),
                    eq(systemConnections.userId, currentUserId)
                ));

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };
    } catch (error) {
        console.error('Integrations API Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};