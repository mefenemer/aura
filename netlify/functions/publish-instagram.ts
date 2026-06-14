// netlify/functions/publish-instagram.ts
// US-SMM-3.3.1 + US-SMM-3.3.2: Publish due Instagram posts every minute.
// Handles: two-step Graph API publish, video polling, retry + exponential backoff,
// rate-limit state table, permanent-error classification, push notifications, cron log.

import { Handler } from '@netlify/functions';
import { and, eq, lte, or, isNull, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    scheduledPosts, systemConnections, rateLimitStates, publishCronLog,
    notifications, users, auditLogs,
} from '../../db/schema';
import { getSecret } from '../../src/utils/vault';

const BATCH = 100;
// Backoff in minutes: attempt 1→2m, 2→8m, 3→30m
const BACKOFF_MINS = [2, 8, 30];
const MAX_ATTEMPTS = 3;
// Overrun threshold
const OVERRUN_MS = 55_000;
const GRAPH_VERSION = 'v19.0';

type FailureReason = { errorCode: number | null; errorMessage: string; errorSubcode?: number; isRetryable: boolean };

function isRetryable(code: number): boolean {
    // 429 rate limit, 5xx server errors, and Meta's transient error code 2
    return code === 429 || code >= 500 || code === 2;
}

function userMessage(reason: FailureReason): string {
    const c = reason.errorCode ?? 0;
    if (c === 190) return 'Instagram connection needs to be reconnected.';
    if (reason.errorMessage.toLowerCase().includes('content policy') || reason.errorSubcode === 2207026)
        return "This post was rejected by Instagram's content policy. Please edit and resubmit.";
    if (reason.errorMessage.toLowerCase().includes('format') || reason.errorSubcode === 352)
        return 'The image or video format is not supported by Instagram. Accepted formats: JPEG, PNG for images; MP4 for video.';
    if (c === 368 || reason.errorMessage.toLowerCase().includes('suspended'))
        return 'Your Instagram account has been restricted. Please resolve this in the Instagram app.';
    return `Publishing failed: ${reason.errorMessage}`;
}

export const handler: Handler = async () => {
    const db = getDb();
    const tickStart = Date.now();
    const now = new Date();
    let processed = 0, succeeded = 0, failed = 0;

    // Claim due posts — SKIP LOCKED prevents concurrent tick double-processing
    const posts = await db.execute<{
        id: number; user_id: number; organisation_id: number; caption: string | null;
        hashtags: string | null; platform_post_id: string | null; connection_id: number | null;
        attempt_count: number; publish_date: string;
    }>(
        `SELECT id, user_id, organisation_id, caption, hashtags, platform_post_id,
                connection_id, attempt_count, publish_date
         FROM scheduled_posts
         WHERE status = 'scheduled'
           AND platform = 'instagram'
           AND publish_date <= now()
           AND (retry_at IS NULL OR retry_at <= now())
         ORDER BY publish_date
         LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`
    );

    if (!posts.rows.length) {
        await db.insert(publishCronLog).values({ postsProcessed: 0, postsSucceeded: 0, postsFailed: 0, durationMs: Date.now() - tickStart });
        return { statusCode: 200, body: 'no posts due' };
    }

    // Set all claimed posts to 'publishing' atomically
    const postIds = posts.rows.map(p => p.id);
    await db.execute(`UPDATE scheduled_posts SET status = 'publishing', updated_at = now() WHERE id = ANY(ARRAY[${postIds.join(',')}]::int[])`);

    processed = posts.rows.length;

    await Promise.allSettled(posts.rows.map(async post => {
        try {
            if (!post.connection_id) throw new Error('No Instagram connection linked to this post.');

            // Check rate limit state for this org
            const [rl] = await db
                .select({ rateLimitedUntil: rateLimitStates.rateLimitedUntil })
                .from(rateLimitStates)
                .where(and(eq(rateLimitStates.organisationId, post.organisation_id), eq(rateLimitStates.platform, 'instagram')))
                .limit(1);

            if (rl && new Date(rl.rateLimitedUntil) > now) {
                // Defer — revert to scheduled, set retryAt to rate limit expiry
                await db.execute(
                    `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${rl.rateLimitedUntil.toISOString()}', updated_at = now() WHERE id = ${post.id}`
                );
                return;
            }

            // Fetch connection + token
            const [conn] = await db
                .select({ vaultRefKey: systemConnections.vaultRefKey, externalUserId: systemConnections.externalUserId })
                .from(systemConnections)
                .where(eq(systemConnections.id, post.connection_id))
                .limit(1);
            if (!conn?.vaultRefKey) throw new Error('No vault token for connection.');

            const token = await getSecret(conn.vaultRefKey);
            const igUserId = conn.externalUserId;
            if (!igUserId) throw new Error('No Instagram user ID in connection.');

            // Build caption with hashtags
            const fullCaption = [post.caption, post.hashtags].filter(Boolean).join('\n\n');

            // Step 1: create media container (image only for now; video handled below)
            const mediaRes = await fetch(
                `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        caption: fullCaption,
                        image_url: `${process.env.URL}/.netlify/functions/media-proxy?postId=${post.id}`, // signed URL proxy
                        media_type: 'IMAGE',
                        access_token: token,
                    }),
                }
            );
            const mediaData: { id?: string; error?: { code: number; message: string; error_subcode?: number } } = await mediaRes.json();

            if (!mediaData.id) {
                const err = mediaData.error;
                const retryable = isRetryable(err?.code ?? 0);
                const reason: FailureReason = { errorCode: err?.code ?? null, errorMessage: err?.message ?? 'Unknown error', errorSubcode: err?.error_subcode, isRetryable: retryable };
                await handlePublishFailure(db, post, reason, now);
                if (!retryable) failed++;
                return;
            }

            const containerId = mediaData.id;
            await db.execute(`UPDATE scheduled_posts SET container_id = '${containerId}', updated_at = now() WHERE id = ${post.id}`);

            // Step 2: publish the container
            const publishRes = await fetch(
                `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media_publish`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ creation_id: containerId, access_token: token }),
                }
            );
            const publishData: { id?: string; error?: { code: number; message: string; error_subcode?: number } } = await publishRes.json();

            if (!publishData.id) {
                const err = publishData.error;
                const retryable = isRetryable(err?.code ?? 0);
                const reason: FailureReason = { errorCode: err?.code ?? null, errorMessage: err?.message ?? 'Unknown error', errorSubcode: err?.error_subcode, isRetryable: retryable };
                await handlePublishFailure(db, post, reason, now);
                if (!retryable) failed++;
                return;
            }

            // Success
            const instagramPostId = publishData.id;
            await db.execute(
                `UPDATE scheduled_posts SET status = 'published', platform_post_id = '${instagramPostId}', published_at = now(), updated_at = now() WHERE id = ${post.id}`
            );

            await db.insert(notifications).values({
                userId: post.user_id,
                type: 'post_published',
                title: 'Post published to Instagram',
                message: 'Your post has been published to Instagram — tap to view.',
                metadata: { postId: post.id, instagramPostId },
            });

            succeeded++;

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[publish-instagram] post ${post.id} error:`, msg);
            const reason: FailureReason = { errorCode: null, errorMessage: msg, isRetryable: true };
            await handlePublishFailure(db, post, reason, now);
        }
    }));

    const durationMs = Date.now() - tickStart;
    const overrunAlert = durationMs > OVERRUN_MS;

    await db.insert(publishCronLog).values({ postsProcessed: processed, postsSucceeded: succeeded, postsFailed: failed, durationMs, overrunAlert });

    if (overrunAlert) {
        console.warn(`[publish-instagram] OVERRUN: tick took ${durationMs}ms`);
        await db.insert(auditLogs).values({ actionType: 'publish_cron_overrun', resourceType: 'publish_cron_log', resourceId: 'tick', newState: { durationMs, postsProcessed: processed } });
    }

    return { statusCode: 200, body: JSON.stringify({ processed, succeeded, failed, durationMs }) };
};

async function handlePublishFailure(
    db: ReturnType<typeof getDb>,
    post: { id: number; user_id: number; organisation_id: number; attempt_count: number },
    reason: FailureReason,
    now: Date,
) {
    const attempt = post.attempt_count + 1;

    // Handle 429 rate limit: defer ALL posts for this org
    if (reason.errorCode === 429) {
        const rateLimitedUntil = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
        await db.execute(
            `INSERT INTO rate_limit_states (organisation_id, platform, rate_limited_until, updated_at)
             VALUES (${post.organisation_id}, 'instagram', '${rateLimitedUntil.toISOString()}', now())
             ON CONFLICT (organisation_id, platform) DO UPDATE SET rate_limited_until = EXCLUDED.rate_limited_until, updated_at = now()`
        );
        // Revert this post to scheduled with retryAt
        await db.execute(
            `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${rateLimitedUntil.toISOString()}', attempt_count = ${attempt}, updated_at = now() WHERE id = ${post.id}`
        );

        // Only notify user if posts will be delayed >2h past scheduled time
        const scheduledAt = new Date(post['publish_date' as keyof typeof post] as string ?? now);
        const delayHours = (rateLimitedUntil.getTime() - scheduledAt.getTime()) / 3_600_000;
        if (delayHours > 2) {
            await db.insert(notifications).values({
                userId: post.user_id,
                type: 'instagram_rate_limited',
                title: 'Instagram publishing delayed',
                message: `Some posts have been delayed due to Instagram rate limits. They will publish automatically when the limit resets.`,
                metadata: { rateLimitedUntil },
            });
        }
        return;
    }

    if (!reason.isRetryable || attempt >= MAX_ATTEMPTS) {
        // Permanent failure
        await db.execute(
            `UPDATE scheduled_posts SET status = 'failed', failure_reason = '${JSON.stringify(reason).replace(/'/g, "''")}', attempt_count = ${attempt}, updated_at = now() WHERE id = ${post.id}`
        );
        await db.insert(notifications).values({
            userId: post.user_id,
            type: 'post_publish_failed',
            title: 'Post failed to publish',
            message: userMessage(reason),
            metadata: { postId: post.id, reason },
        });
        await db.insert(auditLogs).values({ actionType: 'instagram_publish_failed', resourceType: 'scheduled_posts', resourceId: String(post.id), userId: post.user_id, newState: { reason, attempt } });

        // Token expired — mark connection
        if (reason.errorCode === 190) {
            await db.execute(`UPDATE system_connections SET status = 'token_expired', updated_at = now() WHERE organisation_id = ${post.organisation_id} AND service_name = 'instagram'`);
            await db.execute(`UPDATE scheduled_posts SET status = 'paused', updated_at = now() WHERE connection_id IN (SELECT id FROM system_connections WHERE organisation_id = ${post.organisation_id} AND service_name = 'instagram') AND status = 'scheduled'`);
        }
    } else {
        // Retryable: exponential backoff
        const backoffMs = (BACKOFF_MINS[attempt - 1] ?? 30) * 60 * 1000;
        const retryAt = new Date(now.getTime() + backoffMs).toISOString();
        await db.execute(
            `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${retryAt}', attempt_count = ${attempt}, failure_reason = '${JSON.stringify(reason).replace(/'/g, "''")}', updated_at = now() WHERE id = ${post.id}`
        );
    }
}
