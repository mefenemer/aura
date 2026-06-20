// netlify/functions/approve-post.ts
// US-SMM-2.2.1: One-click post approval with past-schedule detection and audit logging.
//
// POST /.netlify/functions/approve-post
//   Auth: aura_session cookie
//   Body: { postId: number, action?: 'approve' | 'publish_now' | 'reschedule', rescheduleAt?: string }
//
// Returns:
//   200 { approved: true, post, confirmation }         — success
//   409 { pastSchedule: true, scheduledFor, platform } — scheduled time in past, awaiting user action

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { aiAssistants, auditLogs, scheduledPosts } from '../../db/schema';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

function getUserId(event: any): number | null {
    try {
        const cookie = event.headers.cookie || '';
        const match  = cookie.match(/aura_session=([^;]+)/);
        if (!match) return null;
        const payload: any = jwt.verify(match[1], JWT_SECRET);
        return payload.userId ?? null;
    } catch {
        return null;
    }
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const userId = getUserId(event);
    if (!userId) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised.' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { postId, action = 'approve', rescheduleAt, rejectionReason } = body;
    if (!postId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'postId is required.' }) };
    }

    const db  = getDb();
    const now = new Date();

    // ── Reject ─────────────────────────────────────────────────────────────────
    if (action === 'reject') {
        if (!rejectionReason?.trim()) {
            return { statusCode: 400, body: JSON.stringify({ error: 'rejectionReason is required when rejecting.' }) };
        }
        const [rejected] = await db.update(scheduledPosts)
            .set({ status: 'rejected', rejectedAt: now, rejectionReason: rejectionReason.trim(), updatedAt: now })
            .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)))
            .returning();
        if (!rejected) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };
        await db.insert(auditLogs).values({
            userId,
            actionType: 'POST_REJECTED',
            resourceType: 'scheduled_posts',
            resourceId: String(postId),
            newState: { rejectionReason: rejectionReason.trim(), rejectedAt: now.toISOString() },
        }).catch(() => {});
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rejected: true, post: rejected }),
        };
    }

    // Load post and verify ownership (via userId on the post)
    const [post] = await db
        .select()
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)))
        .limit(1);

    if (!post) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };
    }

    if (!['draft', 'in_review', 'pending_approval'].includes(post.status)) {
        return {
            statusCode: 409,
            body: JSON.stringify({ error: `Post is already in '${post.status}' state and cannot be approved.` }),
        };
    }

    const scheduledFor = new Date(post.publishDate);
    const isPastSchedule = scheduledFor <= now;

    // ── Past-schedule guard ────────────────────────────────────────────────────
    if (isPastSchedule && action === 'approve') {
        return {
            statusCode: 409,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pastSchedule: true,
                scheduledFor: scheduledFor.toISOString(),
                platform: post.platform,
                message: `The scheduled time for this post (${scheduledFor.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}) has passed. Would you like to reschedule or publish now?`,
            }),
        };
    }

    // ── Determine new publish date ─────────────────────────────────────────────
    let newPublishDate = scheduledFor;

    if (action === 'publish_now') {
        newPublishDate = now;
    } else if (action === 'reschedule') {
        if (!rescheduleAt) {
            return { statusCode: 400, body: JSON.stringify({ error: 'rescheduleAt is required for the reschedule action.' }) };
        }
        const parsed = new Date(rescheduleAt);
        if (isNaN(parsed.getTime())) {
            return { statusCode: 400, body: JSON.stringify({ error: 'rescheduleAt is not a valid date.' }) };
        }
        if (parsed <= now) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Rescheduled time must be in the future.' }) };
        }
        newPublishDate = parsed;
    }

    // ── Approve ────────────────────────────────────────────────────────────────
    // Approval lands the post directly in the publisher's state machine as 'scheduled'
    // — the publish-queue index + cron consume status='scheduled' AND publish_date <= now()
    // (schema.ts: scheduled_posts_publish_queue_idx). For publish_now the date is already
    // set to now; a future date schedules it. (Approver attribution is in the audit log.)
    const [updated] = await db.update(scheduledPosts)
        .set({
            status:      'scheduled',
            publishDate: newPublishDate,
            updatedAt:   now,
        })
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)))
        .returning();

    // ── Audit log: userId, postId, approvedAt, scheduledFor ───────────────────
    await db.insert(auditLogs).values({
        userId,
        actionType:   'POST_APPROVED',
        resourceType: 'scheduled_posts',
        resourceId:   String(postId),
        newState: {
            action,
            approvedAt:   now.toISOString(),
            scheduledFor: newPublishDate.toISOString(),
            platform:     post.platform,
        },
    }).catch(() => {});

    // ── Build confirmation message ─────────────────────────────────────────────
    const dateLabel = newPublishDate.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    const confirmation = action === 'publish_now'
        ? `Post approved and queued to publish now on ${post.platform}.`
        : `Post approved. Scheduled for ${dateLabel} on ${post.platform}.`;

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true, post: updated, confirmation }),
    };
};
