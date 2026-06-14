// netlify/functions/set-draft-horizon.ts
// US-SMM-2.4.1: Update the draft horizon (days ahead the assistant keeps the queue filled).
//
// PATCH /.netlify/functions/set-draft-horizon
//   Auth: aura_session cookie
//   Body: { assistantId: number, draftHorizonDays: number (1–30) }
//
// Side effects:
//   • Horizon increase → enqueues a gap-fill task run + notifies user of new drafts added
//   • Horizon decrease → archives pending drafts beyond new horizon with a note

import { Handler } from '@netlify/functions';
import { and, eq, gt, lt, gte, lte } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { aiAssistants, notifications, scheduledPosts, taskRuns } from '../../db/schema';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const MIN_HORIZON = 1;
const MAX_HORIZON = 30;

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
    if (event.httpMethod !== 'PATCH') {
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

    const { assistantId, draftHorizonDays } = body;
    if (!assistantId || draftHorizonDays == null) {
        return { statusCode: 400, body: JSON.stringify({ error: 'assistantId and draftHorizonDays are required.' }) };
    }

    const days = Number(draftHorizonDays);
    if (!Number.isInteger(days) || days < MIN_HORIZON || days > MAX_HORIZON) {
        return {
            statusCode: 400,
            body: JSON.stringify({ error: `draftHorizonDays must be an integer between ${MIN_HORIZON} and ${MAX_HORIZON}.` }),
        };
    }

    const db = getDb();

    // Load current assistant (verify ownership)
    const [assistant] = await db
        .select({ id: aiAssistants.id, draftHorizonDays: aiAssistants.draftHorizonDays, name: aiAssistants.name })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.userId, userId)))
        .limit(1);

    if (!assistant) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
    }

    const previousHorizon = assistant.draftHorizonDays ?? 7;
    const isExpanding = days > previousHorizon;
    const isShrinking = days < previousHorizon;

    // Persist the new horizon value
    await db.update(aiAssistants)
        .set({ draftHorizonDays: days, updatedAt: new Date() })
        .where(eq(aiAssistants.id, assistantId));

    // ── Horizon expanded → schedule a gap-fill task run ───────────────────────
    if (isExpanding) {
        const newWindowStart = new Date();
        newWindowStart.setDate(newWindowStart.getDate() + previousHorizon);
        const newWindowEnd = new Date();
        newWindowEnd.setDate(newWindowEnd.getDate() + days);

        // userId is required NOT NULL on taskRuns; look it up from the assistant record
        await db.insert(taskRuns).values({
            userId,
            assistantId,
            taskType: 'draft_gap_fill',
            status: 'pending',
            metadata: {
                reason: 'horizon_expanded',
                previousHorizonDays: previousHorizon,
                newHorizonDays: days,
                fillFromDate: newWindowStart.toISOString(),
                fillToDate: newWindowEnd.toISOString(),
            },
        });

        // Notify user
        const fromDate = newWindowStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        const toDate   = newWindowEnd.toLocaleDateString('en-GB',   { day: 'numeric', month: 'short' });
        await db.insert(notifications).values({
            userId,
            type: 'draft_horizon_expanded',
            title: 'Draft horizon extended',
            message: `${assistant.name} will now generate drafts for the period ${fromDate} – ${toDate}. New posts will appear in your Review Queue shortly.`,
        }).catch(() => {});
    }

    // ── Horizon shrunk → archive pending drafts beyond new cutoff ────────────
    if (isShrinking) {
        const newCutoff = new Date();
        newCutoff.setDate(newCutoff.getDate() + days);

        const archived = await db.update(scheduledPosts)
            .set({
                status: 'cancelled',
                cancelledAt: new Date(),
                rejectionReason: 'Outside current draft horizon',
                updatedAt: new Date(),
            })
            .where(and(
                eq(scheduledPosts.assistantId, assistantId),
                eq(scheduledPosts.status, 'draft'),
                gt(scheduledPosts.publishDate, newCutoff),
            ))
            .returning({ id: scheduledPosts.id });

        if (archived.length > 0) {
            await db.insert(notifications).values({
                userId,
                type: 'draft_horizon_shrunk',
                title: 'Draft horizon shortened',
                message: `${archived.length} unreviewed draft${archived.length === 1 ? '' : 's'} beyond your new ${days}-day window have been moved to Archived Drafts.`,
            }).catch(() => {});
        }
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            updated: true,
            draftHorizonDays: days,
            previousHorizonDays: previousHorizon,
            gapFillEnqueued: isExpanding,
        }),
    };
};
