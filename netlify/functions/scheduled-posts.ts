// scheduled-posts.ts — Content Calendar post CRUD + governance
//
// GET    ?from=ISO&to=ISO  → posts in date range for user's org
// GET    ?id=N              → single post detail
// POST                      → create draft post
// PATCH  ?id=N              → update status / caption / publishDate (reschedule)
// DELETE ?id=N              → cancel + soft-delete (status=cancelled)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, gte, lte, or } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, scheduledPosts, contentAssets } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

const VALID_STATUSES = new Set(['draft', 'in_review', 'approved', 'scheduled', 'published', 'rejected', 'cancelled']);

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return null;
    try { return (jwt.verify(cookie, jwtSecret) as { userId: number }).userId; } catch { return null; }
}

export const handler: Handler = async (event) => {
    const userId = getAuth(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();
    const [user] = await db.select({ id: users.id, organisationId: users.organisationId })
        .from(users).where(eq(users.id, userId));
    if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

    const qs = event.queryStringParameters || {};

    try {
        // ── GET ───────────────────────────────────────────────────
        if (event.httpMethod === 'GET') {
            // Single post detail
            if (qs.id) {
                const postId = parseInt(qs.id);
                const [post] = await db.select().from(scheduledPosts)
                    .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)));
                if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

                // Enrich with asset data if any
                const assetIds: number[] = Array.isArray(post.contentAssetIds) ? post.contentAssetIds as number[] : [];
                let assets: any[] = [];
                if (assetIds.length > 0) {
                    assets = await db.select({
                        id: contentAssets.id,
                        name: contentAssets.name,
                        assetType: contentAssets.assetType,
                        storageUrl: contentAssets.storageUrl,
                        externalUrl: contentAssets.externalUrl,
                        mimeType: contentAssets.mimeType,
                    }).from(contentAssets)
                      .where(eq(contentAssets.userId, userId));
                    assets = assets.filter(a => assetIds.includes(a.id));
                }

                return { statusCode: 200, body: JSON.stringify({ post, assets }) };
            }

            // Range query — default to current month if no params
            const from = qs.from ? new Date(qs.from) : (() => { const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; })();
            const to   = qs.to   ? new Date(qs.to)   : (() => { const d = new Date(); d.setMonth(d.getMonth()+1,0); d.setHours(23,59,59,999); return d; })();

            const posts = await db.select().from(scheduledPosts)
                .where(and(
                    eq(scheduledPosts.userId, userId),
                    gte(scheduledPosts.publishDate, from),
                    lte(scheduledPosts.publishDate, to),
                ));

            return { statusCode: 200, body: JSON.stringify({ posts }) };
        }

        // ── POST: create ──────────────────────────────────────────
        if (event.httpMethod === 'POST') {
            const body = JSON.parse(event.body || '{}');
            const {
                assistantId, platform, postFormat, publishDate,
                caption, contentAssetIds, linkUrl, ctaText, hashtags, mentions, utmParams,
                status, ownerLabel, isAutonomous, campaign, pillar,
            } = body;

            if (!platform || !postFormat || !publishDate) {
                return { statusCode: 400, body: JSON.stringify({ error: 'platform, postFormat, and publishDate are required.' }) };
            }

            const [created] = await db.insert(scheduledPosts).values({
                assistantId: assistantId || null,
                userId,
                organisationId: user.organisationId ?? null,
                platform,
                postFormat,
                publishDate: new Date(publishDate),
                caption: caption || null,
                contentAssetIds: contentAssetIds || [],
                linkUrl: linkUrl || null,
                ctaText: ctaText || null,
                hashtags: hashtags || null,
                mentions: mentions || null,
                utmParams: utmParams || null,
                status: status || 'draft',
                ownerId: userId,
                ownerLabel: ownerLabel || null,
                isAutonomous: isAutonomous || false,
                campaign: campaign || null,
                pillar: pillar || null,
            }).returning();

            return { statusCode: 201, body: JSON.stringify({ post: created }) };
        }

        // ── PATCH: update ─────────────────────────────────────────
        if (event.httpMethod === 'PATCH') {
            const postId = parseInt(qs.id || '');
            if (!postId) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const [existing] = await db.select().from(scheduledPosts)
                .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)));
            if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

            // Published posts are immutable
            if (existing.status === 'published') {
                return { statusCode: 409, body: JSON.stringify({ error: 'Published posts cannot be modified.' }) };
            }

            const body = JSON.parse(event.body || '{}');
            const updates: Record<string, any> = { updatedAt: new Date() };

            const editableFields = ['caption', 'linkUrl', 'ctaText', 'hashtags', 'mentions', 'utmParams', 'campaign', 'pillar', 'postFormat', 'contentAssetIds'];
            editableFields.forEach(f => { if (body[f] !== undefined) updates[f] = body[f]; });

            if (body.publishDate) {
                updates.publishDate = new Date(body.publishDate);
            }

            if (body.status) {
                if (!VALID_STATUSES.has(body.status)) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid status.' }) };
                }
                updates.status = body.status;
                if (body.status === 'rejected') {
                    updates.rejectedAt = new Date();
                    updates.rejectionReason = body.rejectionReason || null;
                }
                if (body.status === 'cancelled') {
                    updates.cancelledAt = new Date();
                }
                if (body.status === 'published') {
                    updates.publishedAt = new Date();
                    updates.platformPostUrl = body.platformPostUrl || null;
                    updates.platformPostId = body.platformPostId || null;
                }
            }

            const [updated] = await db.update(scheduledPosts).set(updates)
                .where(eq(scheduledPosts.id, postId)).returning();

            return { statusCode: 200, body: JSON.stringify({ post: updated }) };
        }

        // ── DELETE: cancel/remove ─────────────────────────────────
        if (event.httpMethod === 'DELETE') {
            const postId = parseInt(qs.id || '');
            if (!postId) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const [existing] = await db.select().from(scheduledPosts)
                .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)));
            if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

            if (existing.status === 'published') {
                return { statusCode: 409, body: JSON.stringify({ error: 'Published posts cannot be deleted.' }) };
            }

            // Soft-cancel rather than hard-delete so the calendar history is preserved
            const [cancelled] = await db.update(scheduledPosts).set({
                status: 'cancelled',
                cancelledAt: new Date(),
                updatedAt: new Date(),
            }).where(eq(scheduledPosts.id, postId)).returning();

            return { statusCode: 200, body: JSON.stringify({ post: cancelled }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (err: any) {
        // Table not yet migrated — return empty payload so the calendar renders
        const msg: string = err?.message || '';
        if (msg.includes('relation') && msg.includes('does not exist')) {
            console.warn('[scheduled-posts] Table missing — run db:push to apply migrations.');
            if (event.httpMethod === 'GET' && !event.queryStringParameters?.id) {
                return { statusCode: 200, body: JSON.stringify({ posts: [] }) };
            }
            return { statusCode: 503, body: JSON.stringify({ error: 'Database schema not yet applied. Please run db:push.' }) };
        }
        console.error('Scheduled Posts Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};
