// netlify/functions/upload-asset.ts
import { HandlerEvent } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import Busboy from 'busboy';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, workspaceAssets } from '../../db/schema';
import { logAuditEvent } from '../../src/utils/audit';

const jwtSecret = process.env.JWT_SECRET;

// Helper function to wrap Busboy stream parsing into a clean Async/Await Promise
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

        // Netlify base64 encodes binary bodies, so we decode it before feeding it to Busboy
        busboy.end(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : event.body);
    });
};

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // 1. Authenticate the User
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

        // Ensure user exists and grab their Workspace (Organisation) ID
        const [user] = await db.select().from(users).where(eq(users.id, userId));
        if (!user || !user.organisationId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Workspace context missing.' }) };
        }

        // 2. Parse the Multipart Form Data
        const { fields, file, fileName } = await parseMultipartForm(event);
        const { category, url } = fields;

        if (!category) return { statusCode: 400, body: JSON.stringify({ error: 'Category is required.' }) };

        let assetName = '';
        let finalStorageUrl = null;
        let finalExternalUrl = null;
        const assetType = file ? 'file' : 'url';

        // 3. Route Logic: File vs URL
        if (assetType === 'file') {
            if (!file) return { statusCode: 400, body: JSON.stringify({ error: 'No file detected.' }) };

            assetName = fileName;

            // ------------------------------------------------------------------
            // [ENTERPRISE STORAGE DROP-IN]
            // Upload the `file` buffer to AWS S3, Cloudinary, or Netlify Blobs here.
            // Example:
            // const s3Upload = await s3Client.send(new PutObjectCommand({ Bucket, Key, Body: file }));
            // finalStorageUrl = `https://your-bucket.s3.amazonaws.com/${Key}`;
            // ------------------------------------------------------------------

            finalStorageUrl = `https://mock-storage.aura-assist.com/workspaces/${user.organisationId}/${fileName}`;

        } else {
            if (!url) return { statusCode: 400, body: JSON.stringify({ error: 'No URL provided.' }) };
            assetName = url;
            finalExternalUrl = url;
        }

        // 4. Save to the Database (Scenario 4)
        const [newAsset] = await db.insert(workspaceAssets).values({
            organisationId: user.organisationId,
            uploaderId: userId,
            name: assetName,
            assetType: assetType,
            category: category,
            storageUrl: finalStorageUrl,
            externalUrl: finalExternalUrl,
            status: 'processing' // Initially set to processing while RAG extraction occurs
        }).returning();

        // 5. Append to the Secure Audit Log
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
        // (In a production environment, you would push this task to a queue like Redis/Upstash
        // or invoke a Netlify Background Function to extract the text without keeping the user waiting).
        console.log(`[RAG TRIGGERED] Kicked off extraction job for Asset ID: ${newAsset.id}`);
        // 6. Trigger Background Scraper/RAG Worker
        const host = event.headers?.host || 'localhost:8888';
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const backgroundEndpoint = `${protocol}://${host}/.netlify/functions/process-asset-background`;

        // We use fetch without `await` (or ignore the response) so the user isn't kept waiting
        fetch(backgroundEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetId: newAsset.id })
        }).catch(err => console.error("Failed to trigger background worker:", err));

        return { statusCode: 200, body: JSON.stringify({ success: true, asset: newAsset }) };

    } catch (error) {
        console.error('Upload Asset Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to upload asset.' }) };
    }
};