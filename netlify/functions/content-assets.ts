// content-assets.ts — My Content Media Hub CRUD
// GET    → list all assets for user's org, grouped by status
// POST   → create a new asset record (file metadata or link) + run safety scan
// PATCH  → update asset status (e.g., pending → scheduled, detach from post)
// DELETE → remove an asset record (and physical file if applicable)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, contentAssets, userOrganisations } from '../../db/schema';
import { presignR2Get } from '../../src/utils/social-publish';

const jwtSecret = process.env.JWT_SECRET;

// ── Be More Swan Safe Content Benchmark ───────────────────────────────────────────────
// Runs a safety check on a newly uploaded asset.
// Primary path: OpenAI Moderation API (https://platform.openai.com/docs/guides/moderation)
// Fallback:     rule-based keyword scan on name/mimeType when no API key is set.
//
// Returns: { safe: boolean, reason?: string }
async function runSafetyCheck(asset: {
    name: string;
    assetType: string;
    mimeType?: string | null;
    storageUrl?: string | null;
    externalUrl?: string | null;
}): Promise<{ safe: boolean; reason?: string }> {
    try {
        const openaiKey = process.env.OPENAI_API_KEY;

        if (openaiKey) {
            // ── OpenAI text moderation on the asset name / URL ────────────
            const inputText = [asset.name, asset.externalUrl].filter(Boolean).join(' ');
            const modRes = await fetch('https://api.openai.com/v1/moderations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiKey}`,
                },
                body: JSON.stringify({ input: inputText }),
            });

            if (modRes.ok) {
                const modData = await modRes.json();
                const result = modData.results?.[0];
                if (result?.flagged) {
                    // Find the most-violated category for the rejection reason
                    const cats: Record<string, boolean> = result.categories || {};
                    const violated = Object.entries(cats)
                        .filter(([, v]) => v)
                        .map(([k]) => k.replace(/\//g, ' ').replace(/-/g, ' '))
                        .join(', ');
                    return {
                        safe: false,
                        reason: `Violates Safety Guidelines: ${violated || 'Content policy violation'}.`,
                    };
                }
            }
        }

        // ── Rule-based fallback (applies even when OpenAI is configured) ──
        // Catches obviously flagged file names regardless of API availability.
        const VIOLATION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
            { pattern: /\bnudity\b|\bnude\b|\bporn\b|\bxxx\b/i,       reason: 'Violates Safety Guidelines: Contains nudity.' },
            { pattern: /\bviolenc[e]?\b|\bgorgor[e]?\b|\bblood\b/i,   reason: 'Violates Safety Guidelines: Contains graphic violence.' },
            { pattern: /\bhate[_\s]?speech\b|\bracist\b|\bslur\b/i,   reason: 'Violates Safety Guidelines: Contains hate speech.' },
            { pattern: /\bweapon[s]?\b|\bbomb\b|\bexplosiv[e]?\b/i,   reason: 'Violates Safety Guidelines: References dangerous weapons.' },
        ];
        const textToCheck = [asset.name, asset.externalUrl].filter(Boolean).join(' ');
        for (const { pattern, reason } of VIOLATION_PATTERNS) {
            if (pattern.test(textToCheck)) {
                return { safe: false, reason };
            }
        }

        return { safe: true };
    } catch (err) {
        // Safety scan errors must never block uploads — log and pass through.
        console.error('[content-moderate] Safety scan error (asset passed through):', err);
        return { safe: true };
    }
}

// ── Bulk asset status propagation (called from scheduled-posts.ts logic) ─────
// Exported so scheduled-posts.ts can import it, avoiding a second HTTP round-trip.
export async function propagateAssetStatuses(
    db: any,
    assetIds: number[],
    fromStatus: string,
    toStatus: string,
    extra: Record<string, any> = {},
): Promise<void> {
    if (assetIds.length === 0) return;
    const POSTED_RETENTION_MS  = 30 * 24 * 60 * 60 * 1000;
    const REJECTED_RETENTION_MS =  7 * 24 * 60 * 60 * 1000;

    const payload: Record<string, any> = { status: toStatus, updatedAt: new Date(), ...extra };
    if (toStatus === 'posted')  {
        payload.postedAt = new Date();
        payload.retentionDeleteAfter = new Date(Date.now() + POSTED_RETENTION_MS);
    }
    if (toStatus === 'rejected') {
        payload.rejectedAt = new Date();
        payload.retentionDeleteAfter = new Date(Date.now() + REJECTED_RETENTION_MS);
    }

    await db.update(contentAssets)
        .set(payload)
        .where(
            and(
                inArray(contentAssets.id, assetIds),
                eq(contentAssets.status, fromStatus),
            )
        );
}

// ── Physical file deletion ────────────────────────────────────────────────
// Removes an object from S3 using the same config as content-upload-url.ts.
// Best-effort: a storage failure must not block the DB delete (the row is the
// user-facing record), but it is logged so leaked objects can be reconciled.
async function deleteStorageObject(storageKey: string | null | undefined): Promise<void> {
    if (!storageKey) return; // link/URL assets have no physical file
    const bucket = process.env.S3_BUCKET_NAME;
    const region = process.env.S3_REGION || 'us-east-1';
    if (!bucket || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
        console.warn(`[content-assets] S3 not configured — cannot delete object ${storageKey}`);
        return;
    }
    try {
        // Dynamic import so the build doesn't fail when @aws-sdk is not installed.
        const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
        const s3 = new S3Client({ region });
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
    } catch (err) {
        console.error(`[content-assets] Failed to delete S3 object ${storageKey}:`, err);
    }
}

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
    const [user] = await db.select({ id: users.id, organisationId: userOrganisations.organisationId })
        .from(users).leftJoin(userOrganisations, eq(users.id, userOrganisations.userId)).where(eq(users.id, userId));
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
            // Resolve a displayable URL for visual assets (thumbnails in My Content).
            // S3 uploads carry a public storageUrl already; AI-generated images live in the
            // private R2 bucket with only a storageKey, so presign a short-lived GET URL.
            // Mock/dev assets (Pexels/picsum hotlinks) fall back to externalUrl.
            const enriched = await Promise.all(rows.map(async r => {
                if (r.purgedAt) return r;
                const isVisual = r.assetType === 'image' || r.assetType === 'video';
                if (isVisual && !r.storageUrl) {
                    if (r.storageKey) {
                        try { return { ...r, storageUrl: await presignR2Get(r.storageKey) }; }
                        catch { /* fall through to externalUrl below */ }
                    }
                    if (r.externalUrl) return { ...r, storageUrl: r.externalUrl };
                }
                return r;
            }));

            enriched.forEach(r => {
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

            // ── Scenario 3: Safety Benchmark Enforcement ──────────────────
            // Run synchronously so the client receives the final status in one round-trip.
            const { safe, reason } = await runSafetyCheck({
                name,
                assetType,
                mimeType: mimeType || null,
                storageUrl: storageUrl || null,
                externalUrl: externalUrl || null,
            });

            if (!safe) {
                const REJECTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
                const [rejected] = await db.update(contentAssets).set({
                    status: 'rejected',
                    rejectedAt: new Date(),
                    rejectionReason: reason || 'Violates Safety Guidelines.',
                    retentionDeleteAfter: new Date(Date.now() + REJECTED_RETENTION_MS),
                    updatedAt: new Date(),
                }).where(eq(contentAssets.id, created.id)).returning();

                return { statusCode: 201, body: JSON.stringify({ asset: rejected, rejected: true }) };
            }

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

            // userId guard: defence-in-depth — ownership already checked above,
            // but bind userId in the UPDATE to prevent any TOCTOU race.
            const [updated] = await db.update(contentAssets)
                .set(updatePayload)
                .where(and(eq(contentAssets.id, assetId), eq(contentAssets.userId, userId)))
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

            // Delete the physical file from S3 before removing the DB row, so we never
            // leave an orphaned object behind (storage leak + GDPR erasure gap).
            await deleteStorageObject(existing.storageKey);

            await db.delete(contentAssets).where(eq(contentAssets.id, assetId));
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (err: any) {
        const msg: string = err?.message || '';
        if (msg.includes('relation') && msg.includes('does not exist')) {
            console.warn('[content-assets] Table missing — run db:push to apply migrations.');
            if (event.httpMethod === 'GET') {
                return { statusCode: 200, body: JSON.stringify({ assets: { pending: [], scheduled: [], posted: [], rejected: [] } }) };
            }
            return { statusCode: 503, body: JSON.stringify({ error: 'Database schema not yet applied. Please run db:push.' }) };
        }
        console.error('Content Assets Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};
