// netlify/functions/upload-asset.ts
import { HandlerEvent } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Busboy from 'busboy';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, workspaceAssets } from '../../db/schema';
import { logAuditEvent } from '../../src/utils/audit';
import { resolveBaseUrl } from '../../src/utils/base-url';

const jwtSecret = process.env.JWT_SECRET;

const parseMultipartForm = (event: HandlerEvent): Promise<any> => {
    return new Promise((resolve, reject) => {
        const fields: Record<string, string> = {};
        let fileData: Buffer | null = null;
        let fileName = '';
        let mimeType = '';

        const busboy = Busboy({
            headers: {
                'content-type': event.headers['content-type'] || event.headers['Content-Type']
            }
        });

        busboy.on('file', (name, file, info) => {
            fileName = info.filename;
            mimeType = info.mimeType;
            const chunks: Buffer[] = [];
            file.on('data', (data) => chunks.push(data));
            file.on('end', () => { fileData = Buffer.concat(chunks); });
        });

        busboy.on('field', (name, val) => { fields[name] = val; });
        busboy.on('finish', () => resolve({ fields, file: fileData, fileName, mimeType }));
        busboy.on('error', reject);

        busboy.end(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : event.body);
    });
};

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

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
        if (!user || !user.organisationId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Workspace context missing.' }) };
        }

        const { fields, file, fileName } = await parseMultipartForm(event);
        const { category, url } = fields;

        if (!category) return { statusCode: 400, body: JSON.stringify({ error: 'Category is required.' }) };

        let assetName = '';
        let finalStorageUrl = null;
        let finalExternalUrl = null;
        const assetType = file ? 'file' : 'url';

        if (assetType === 'file') {
            if (!file) return { statusCode: 400, body: JSON.stringify({ error: 'No file detected.' }) };
            assetName = fileName;
            return { statusCode: 501, body: JSON.stringify({ error: 'File upload storage is not yet configured.' }) };
        } else {
            if (!url) return { statusCode: 400, body: JSON.stringify({ error: 'No URL provided.' }) };
            assetName = url;
            finalExternalUrl = url;
        }

        const [newAsset] = await db.insert(workspaceAssets).values({
            organisationId: user.organisationId,
            uploaderId: userId,
            name: assetName,
            assetType: assetType,
            category: category,
            storageUrl: finalStorageUrl,
            externalUrl: finalExternalUrl,
            status: 'processing'
        }).returning();

        logAuditEvent({
            userId: userId,
            actionType: 'CREATE',
            resourceType: 'workspace_assets',
            resourceId: newAsset.id,
            newState: newAsset,
            ipAddress: event.headers['client-ip'] || event.headers['x-forwarded-for'] || 'unknown',
            userAgent: event.headers['user-agent'] || 'unknown'
        });

        // 6. Trigger Background Scraper/RAG Worker
        console.log(`[RAG TRIGGERED] Kicked off extraction job for Asset ID: ${newAsset.id}`);
        const uploadBaseUrl = resolveBaseUrl(event.headers);
        if (uploadBaseUrl) {
            fetch(`${uploadBaseUrl}/.netlify/functions/process-asset-background`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assetId: newAsset.id })
            }).catch(err => console.error("Failed to trigger background worker:", err));
        } else {
            console.error('[upload-asset] Could not resolve base URL — background RAG worker not triggered for asset', newAsset.id);
        }

        return { statusCode: 200, body: JSON.stringify({ success: true, asset: newAsset }) };

    } catch (error) {
        console.error('Upload Asset Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to upload asset.' }) };
    }
};