// netlify/functions/add-text-assets.ts
import { HandlerEvent } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, workspaceAssets } from '../../db/schema';
import { logAuditEvent } from '../../src/utils/audit';

const jwtSecret = process.env.JWT_SECRET;

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
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

    try {
        const db = getDb();
        const [user] = await db.select().from(users).where(eq(users.id, userId));

        // 2. Validate Workspace Context
        if (!user || user.organisationId === null) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Workspace context missing.' }) };
        }

        const body = JSON.parse(event.body || '{}');
        const { category, assets } = body;

        if (!category || !Array.isArray(assets) || assets.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid payload.' }) };
        }

        // 3. Map Payload & Insert (Status 'ready' for text assets)
        const insertPayload = assets.map((asset: any) => ({
            organisationId: user.organisationId as number,
            uploaderId: userId,
            name: asset.title,
            assetType: 'text',
            category: category,
            extractedText: asset.content,
            status: 'ready'
        }));

        const insertedAssets = await db.insert(workspaceAssets).values(insertPayload).returning();

        // 4. Audit Log
        insertedAssets.forEach(asset => {
            logAuditEvent({
                userId: userId,
                actionType: 'CREATE',
                resourceType: 'workspace_assets',
                resourceId: asset.id,
                newState: asset
            });
        });

        return { statusCode: 200, body: JSON.stringify({ success: true, count: insertedAssets.length }) };

    } catch (error) {
        console.error('Text Asset Bulk Upload Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};