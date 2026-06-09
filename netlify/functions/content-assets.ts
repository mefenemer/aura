// content-assets.ts — My Content Media Hub CRUD
// GET    → list all assets for user's org, grouped by status
// POST   → create a new asset record (file metadata or link)
// PATCH  → update asset status (e.g., pending → scheduled, detach from post)
// DELETE → remove an asset record (and physical file if applicable)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, contentAssets } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

// Retention windows (milliseconds)
const POSTED_RETENTION_MS  = 30 * 24 * 60 * 60 * 1000; // 30 days
const REJECTED_RETENTION_MS =  7 * 24 * 60 * 60 * 1000; //  7 days

function auth(event: any): number | null {
    if (!jwtSecret) return null;
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return null;
    try {
        return (jwt.verify(cookie, jwtSecret) as { userId: number }).userId;
    } catch {
        return null;
    }
}

export const handler: Handler = async (event) => {
    const userId = auth(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    // ── Fetch user + org ──────────────────────────────────────────
    const [user] = await db.select({ id: users.id, organisationId: users.organisationId })
        .from(users).where(eq(users.id, userId));
    if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };
    const orgId = user.organisationId;

    try {
        // ── GET: list assets ──────────────────────────────────────
        if (event.httpMethod === 'GET') {
            const rows = await db.select().from(contentAssets)
                .where(eq(contentAssets.userId, userId))
                .orderBy(desc(contentAssets.createdAt));

            // Group by status
            const grouped: Record<string, typeof rows> = {
                pending: [], scheduled: [], posted: [], rejected: [],
            };
            rows.forEach(r => {
                if (r.purgedAt) return; // hide physically purged records
                const bucket = grouped[r.status] ?? [];
                bucket.push(r);
                grouped[r.status] = bucket;
            });

            return { statusCode: 200, body: JSON.stringify({ assets: grouped }) };
        }

        // ── POST: create asset record ─────────────────────────────
        if (event.httpMethod === 'POST') {
            const body = JSON.parse(event.body || '{}');
            const { name, assetType, mimeType, fileSize, storageKey, storageUrl, externalUrl } = body;

            if (!name || !assetType) {
                return { statusCode: 400, body: JSON.stringify({ error: 'name and assetType are required.' }) };
            }

            const validTypes = ['image', 'video', 'link'];
            if (!validTypes.includes(assetType)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'assetType must be image, video, or link.' }) };
            }

            if (assetType === 'link' && !externalUrl) {
                return { statusCode: 400, body: JSON.stringify({ error: 'externalUrl is required for link assets.' }) };
            }

            const [created] = await db.insert(contentAssets).values({
                userId,
                organisationId: orgId ?? null,
                name,
                assetType,
                mimeType: mimeType || null,
                fileSize: fileSize || null,
                storageKey: storageKey || null,
                storageUrl: storageUrl || null,
                externalUrl: externalUrl || null,
                status: 'pending',
            }).returning();

            return { statusCode: 201, body: JSON.stringify({ asset: created }) };
        }

        // ── PATCH: update status ──────────────────────────────────
        if (event.httpMethod === 'PATCH') {
            const assetId = parseInt(event.queryStringParameters?.id || '');
            if (!assetId) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const body = JSON.parse(event.body || '{}');
            const { status, rejectionReason, scheduledPostId, action } = body;

            // Verify ownership
            const [existing] = await db.select().from(contentAssets)
                .where(and(eq(contentAssets.id, assetId), eq(contentAssets.userId, userId)));
            if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Asset not found.' }) };

            // Special action: detach from scheduled post (US3)
            if (action === 'detach') {
                const [updated] = await db.update(contentAssets).set({
                    status: 'pending',
                    scheduledPostId: null,
                    updatedAt: new Date(),
                }).where(eq(contentAssets.id, assetId)).returning();
                return { statusCode: 200, body: JSON.stringify({ asset: updated }) };
            }

            const allowedStatuses = ['pending', 'scheduled', 'posted', 'rejected'];
            if (status && !allowedStatuses.includes(status)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Invalid status.' }) };
            }

            const updatePayload: Record<string, any> = { updatedAt: new Date() };

            if (status) {
                updatePayload.status = status;

                if (status === 'posted') {
                    updatePayload.postedAt = new Date();
                    updatePayload.retentionDeleteAfter = new Date(Date.now() + POSTED_RETENTION_MS);
                }
                if (status === 'rejected') {
                    updatePayload.rejectedAt = new Date();
                    updatePayload.rejectionReason = rejectionReason || 'Violates Safety Guidelines.';
                    updatePayload.retentionDeleteAfter = new Date(Date.now() + REJECTED_RETENTION_MS);
                }
                if (status === 'scheduled' && scheduledPostId) {
                    updatePayload.scheduledPostId = scheduledPostId;
                }
            }

            const [updated] = await db.update(contentAssets)
                .set(updatePayload)
                .where(eq(contentAssets.id, assetId))
                .returning();

            return { statusCode: 200, body: JSON.stringify({ asset: updated }) };
        }

        // ── DELETE: remove asset ──────────────────────────────────
        if (event.httpMethod === 'DELETE') {
            const assetId = parseInt(event.queryStringParameters?.id || '');
            if (!assetId) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const [existing] = await db.select().from(contentAssets)
                .where(and(eq(contentAssets.id, assetId), eq(contentAssets.userId, userId)));
            if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Asset not found.' }) };

            // TODO: When S3 is wired, delete the physical file here using existing.storageKey

            await db.delete(contentAssets).where(eq(contentAssets.id, assetId));
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (err) {
        console.error('Content Assets Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};
