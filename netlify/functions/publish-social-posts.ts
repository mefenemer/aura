// netlify/functions/publish-social-posts.ts
// Publish due LinkedIn & X (Twitter) posts every minute — the non-Instagram half of the
// social publisher. Mirrors publish-instagram's orchestration (claim FOR UPDATE SKIP
// LOCKED → 'publishing' → API call → 'published' | retry/backoff | 'failed'), minus the
// Meta media-container flow. Text/caption posts only for now; per-platform media upload
// (LinkedIn assets, X media/upload) is a follow-up.
//
// NOTE: the per-platform API calls follow the documented contracts but have NOT been
// validated against the live LinkedIn/X APIs — verify with real connected accounts before
// relying on them. Facebook is intentionally excluded: it has no distinct connection yet
// (the FB card routes through meta-oauth → serviceName 'instagram').

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, systemConnections, rateLimitStates, publishCronLog, notifications } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';

const BATCH = 100;
const BACKOFF_MINS = [2, 8, 30];
const MAX_ATTEMPTS = 3;
const PLATFORMS = ['linkedin', 'x'];
const LABEL: Record<string, string> = { linkedin: 'LinkedIn', x: 'X (Twitter)' };
const X_MAX = 280;

type FailureReason = { httpStatus: number | null; errorMessage: string; isRetryable: boolean };
type PostRow = {
    id: number; user_id: number; organisation_id: number; caption: string | null;
    hashtags: string | null; connection_id: number | null; attempt_count: number;
    publish_date: string; platform: string;
};

const isRetryable = (s: number | null) => s === 429 || (s != null && s >= 500);
const esc = (s: string) => s.replace(/'/g, "''");

export const handler: Handler = async () => {
    const db = getDb();
    const tickStart = Date.now();
    const now = new Date();
    let processed = 0, succeeded = 0, failed = 0;

    const posts = await db.execute<PostRow>(
        `SELECT id, user_id, organisation_id, caption, hashtags, connection_id,
                attempt_count, publish_date, platform
         FROM scheduled_posts
         WHERE status = 'scheduled'
           AND platform IN ('linkedin','x')
           AND publish_date <= now()
           AND (retry_at IS NULL OR retry_at <= now())
         ORDER BY publish_date
         LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`
    );

    if (!posts.length) {
        await db.insert(publishCronLog).values({ postsProcessed: 0, postsSucceeded: 0, postsFailed: 0, durationMs: Date.now() - tickStart });
        return { statusCode: 200, body: 'no posts due' };
    }

    await db.update(scheduledPosts).set({ status: 'publishing', updatedAt: new Date() })
        .where(inArray(scheduledPosts.id, posts.map(p => p.id)));
    processed = posts.length;

    await Promise.allSettled(posts.map(async post => {
        try {
            // Resolve the connection — by id if the post carries one, else the org's active
            // connection for this platform (generated posts may not pin a connection_id).
            const connWhere = post.connection_id
                ? eq(systemConnections.id, post.connection_id)
                : and(
                    eq(systemConnections.organisationId, post.organisation_id),
                    eq(systemConnections.serviceName, post.platform),
                    eq(systemConnections.isActive, true),
                  );
            const [conn] = await db.select({
                vaultRefKey: systemConnections.vaultRefKey,
                externalUserId: systemConnections.externalUserId,
            }).from(systemConnections).where(connWhere).limit(1);
            if (!conn?.vaultRefKey) throw new Error(`No active ${post.platform} connection for this post.`);

            const secret = await getSecret(db, conn.vaultRefKey);
            const token = secret?.token as string | undefined;
            if (!token) throw new Error('No token in vault for connection.');

            const text = [post.caption, post.hashtags].filter(Boolean).join('\n\n').trim();
            if (!text) throw new Error('Post has no text to publish.');

            const result = post.platform === 'x'
                ? await publishX(text, token)
                : await publishLinkedIn(text, token, conn.externalUserId);

            if (!result.ok) {
                await handleFailure(db, post, { httpStatus: result.status, errorMessage: result.error, isRetryable: isRetryable(result.status) }, now);
                if (!isRetryable(result.status)) failed++;
                return;
            }

            await db.execute(
                `UPDATE scheduled_posts SET status = 'published', platform_post_id = '${esc(result.id)}', published_at = now(), updated_at = now() WHERE id = ${post.id}`
            );
            await db.insert(notifications).values({
                userId: post.user_id,
                type: 'post_published',
                title: `Post published to ${LABEL[post.platform]}`,
                message: `Your post has been published to ${LABEL[post.platform]}.`,
                metadata: { postId: post.id, platform: post.platform, platformPostId: result.id },
            });
            succeeded++;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[publish-social-posts] post ${post.id} error:`, msg);
            await handleFailure(db, post, { httpStatus: null, errorMessage: msg, isRetryable: true }, now);
        }
    }));

    const durationMs = Date.now() - tickStart;
    await db.insert(publishCronLog).values({ postsProcessed: processed, postsSucceeded: succeeded, postsFailed: failed, durationMs });
    return { statusCode: 200, body: JSON.stringify({ processed, succeeded, failed, durationMs }) };
};

// ── Per-platform drivers (text posts) ────────────────────────────────────────
type DriverResult = { ok: true; id: string } | { ok: false; status: number | null; error: string };

async function publishX(text: string, token: string): Promise<DriverResult> {
    const res = await fetch('https://api.twitter.com/2/tweets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: text.slice(0, X_MAX) }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && data?.data?.id) return { ok: true, id: String(data.data.id) };
    return { ok: false, status: res.status, error: data?.detail || data?.title || `X API error (${res.status})` };
}

async function publishLinkedIn(text: string, token: string, authorId: string | null): Promise<DriverResult> {
    if (!authorId) return { ok: false, status: null, error: 'No LinkedIn author URN on connection.' };
    // urn:li:person:<id> for the connected member. (Org pages would use urn:li:organization:<id>.)
    const author = authorId.startsWith('urn:') ? authorId : `urn:li:person:${authorId}`;
    const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'X-Restli-Protocol-Version': '2.0.0',
        },
        body: JSON.stringify({
            author,
            lifecycleState: 'PUBLISHED',
            specificContent: {
                'com.linkedin.ugc.ShareContent': {
                    shareCommentary: { text },
                    shareMediaCategory: 'NONE',
                },
            },
            visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
        }),
    });
    if (res.status === 201 || res.ok) {
        const id = res.headers.get('x-restli-id') || (await res.json().catch(() => ({})) as any)?.id || 'posted';
        return { ok: true, id: String(id) };
    }
    const data: any = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, error: data?.message || `LinkedIn API error (${res.status})` };
}

// ── Failure handling (rate-limit defer / retry backoff / permanent fail) ──────
async function handleFailure(db: ReturnType<typeof getDb>, post: PostRow, reason: FailureReason, now: Date) {
    const attempt = post.attempt_count + 1;

    if (reason.httpStatus === 429) {
        const until = new Date(now.getTime() + 60 * 60 * 1000);
        await db.execute(
            `INSERT INTO rate_limit_states (organisation_id, platform, rate_limited_until, updated_at)
             VALUES (${post.organisation_id}, '${post.platform}', '${until.toISOString()}', now())
             ON CONFLICT (organisation_id, platform) DO UPDATE SET rate_limited_until = EXCLUDED.rate_limited_until, updated_at = now()`
        );
        await db.execute(
            `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${until.toISOString()}', attempt_count = ${attempt}, updated_at = now() WHERE id = ${post.id}`
        );
        return;
    }

    if (!reason.isRetryable || attempt >= MAX_ATTEMPTS) {
        await db.execute(
            `UPDATE scheduled_posts SET status = 'failed', failure_reason = '${esc(JSON.stringify(reason))}', attempt_count = ${attempt}, updated_at = now() WHERE id = ${post.id}`
        );
        await db.insert(notifications).values({
            userId: post.user_id,
            type: 'post_publish_failed',
            title: 'Post failed to publish',
            message: `Publishing to ${LABEL[post.platform]} failed: ${reason.errorMessage}`,
            metadata: { postId: post.id, platform: post.platform, reason },
        });
    } else {
        const retryAt = new Date(now.getTime() + (BACKOFF_MINS[attempt - 1] ?? 30) * 60 * 1000).toISOString();
        await db.execute(
            `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${retryAt}', attempt_count = ${attempt}, failure_reason = '${esc(JSON.stringify(reason))}', updated_at = now() WHERE id = ${post.id}`
        );
    }
}
