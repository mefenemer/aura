// netlify/functions/storage-confirm-upload.ts
// US-STOR-1.2.1: Confirms an upload by verifying the object exists in R2 and updating DB.
//
// POST { assetId }
// → { assetId, assetType, fileSizeBytes }
//
// AC7: 404 if object not in R2
// AC8: 422 if Content-Type mismatch
// AC1 (STOR-1.1.2): Atomically increments storageUsage.usedBytes

import { Handler } from '@netlify/functions';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import jwt from 'jsonwebtoken';
import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userOrganisations, workspaceAssets, storageUsage } from '../../db/schema';

const JWT_SECRET  = process.env.JWT_SECRET;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID     = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET   = process.env.R2_BUCKET_NAME;

function getR2Client(): S3Client {
    return new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY! },
    });
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!JWT_SECRET) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try { userId = (jwt.verify(cookie, JWT_SECRET) as { userId: number }).userId; }
    catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) }; }

    let body: { assetId?: number };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const { assetId } = body;
    if (!assetId) return { statusCode: 400, body: JSON.stringify({ error: 'assetId required.' }) };

    const db = getDb();

    const [asset] = await db
        .select({
            id: workspaceAssets.id,
            organisationId: workspaceAssets.organisationId,
            r2Key: workspaceAssets.r2Key,
            mimeType: workspaceAssets.mimeType,
            fileSizeBytes: workspaceAssets.fileSizeBytes,
            assetType: workspaceAssets.assetType,
            status: workspaceAssets.status,
        })
        .from(workspaceAssets)
        .where(eq(workspaceAssets.id, assetId))
        .limit(1);

    if (!asset) return { statusCode: 404, body: JSON.stringify({ error: 'Asset not found.' }) };
    if (asset.status !== 'pending') return { statusCode: 409, body: JSON.stringify({ error: 'Asset already confirmed.' }) };

    // Verify caller is a member of the asset's org
    const [membership] = await db
        .select({ id: userOrganisations.id })
        .from(userOrganisations)
        .where(and(eq(userOrganisations.userId, userId), eq(userOrganisations.organisationId, asset.organisationId)))
        .limit(1);
    if (!membership) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden.' }) };

    // Mock mode — skip R2 HEAD check
    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
        await db.update(workspaceAssets).set({ status: 'confirmed', updatedAt: new Date() }).where(eq(workspaceAssets.id, assetId));
        return { statusCode: 200, body: JSON.stringify({ assetId, assetType: asset.assetType, fileSizeBytes: asset.fileSizeBytes, mock: true }) };
    }

    // AC7: HEAD the object in R2
    const s3 = getR2Client();
    let head: Awaited<ReturnType<typeof s3.send>>;
    try {
        head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: asset.r2Key! }));
    } catch (err: any) {
        if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Upload not found in storage. Please retry the upload.' }) };
        }
        throw err;
    }

    // AC8: Content-Type must match declared mimeType
    const r2ContentType = (head as any).ContentType || '';
    if (asset.mimeType && r2ContentType && !r2ContentType.startsWith(asset.mimeType.split(';')[0])) {
        return { statusCode: 422, body: JSON.stringify({ error: `Content-Type mismatch: expected ${asset.mimeType}, got ${r2ContentType}` }) };
    }

    // Mark confirmed and atomically increment storage usage (AC1 STOR-1.1.2)
    await db.update(workspaceAssets).set({ status: 'confirmed', updatedAt: new Date() }).where(eq(workspaceAssets.id, assetId));
    if (asset.fileSizeBytes) {
        await db.execute(
            sql`INSERT INTO storage_usage (organisation_id, used_bytes, updated_at)
                VALUES (${asset.organisationId}, ${asset.fileSizeBytes}, now())
                ON CONFLICT (organisation_id)
                DO UPDATE SET used_bytes = storage_usage.used_bytes + ${asset.fileSizeBytes}, updated_at = now()`
        );
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId, assetType: asset.assetType, fileSizeBytes: asset.fileSizeBytes }),
    };
};
