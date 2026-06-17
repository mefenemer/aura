// netlify/functions/draft-horizon-fill.ts
// US-SMM-2.4.1: Daily job — for each active Social Media Manager assistant,
// check how many posts are planned within the draft horizon and enqueue a
// gap-fill task run for each assistant that has uncovered days.
//
// Schedule: "0 6 * * *"  (06:00 UTC daily)
// Does NOT generate post content itself — it enqueues a pending taskRun
// which a worker will pick up and call the AI to fill the gaps.

import { Handler } from '@netlify/functions';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, masterAssistants, scheduledPosts, taskRuns, notifications } from '../../db/schema';

export const handler: Handler = async (event) => {
    // Allow both scheduled invocations and manual POST for testing
    if (event.httpMethod !== 'POST' && !(event as any).schedule) {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const db = getDb();

    // Find all active SMM assistants with their horizon setting
    const smmAssistants = await db
        .select({
            id: aiAssistants.id,
            userId: aiAssistants.userId,
            name: aiAssistants.name,
            draftHorizonDays: aiAssistants.draftHorizonDays,
        })
        .from(aiAssistants)
        .innerJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(
            eq(aiAssistants.isActive, true),
            eq(masterAssistants.roleKey, 'social_media_manager'),
        ));

    let enqueued = 0;
    const now = new Date();

    for (const assistant of smmAssistants) {
        const horizonDays = assistant.draftHorizonDays ?? 7;
        const windowEnd   = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

        // Count posts already in a planned state (draft, in_review, approved, scheduled)
        // within the horizon window — one row per calendar day per platform
        const coveredRows = await db
            .select({ publishDate: scheduledPosts.publishDate, platform: scheduledPosts.platform })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.assistantId, assistant.id),
                gte(scheduledPosts.publishDate, now),
                lte(scheduledPosts.publishDate, windowEnd),
                sql`status IN ('draft','in_review','approved','scheduled')`,
            ));

        // Build a set of "date:platform" already covered
        const covered = new Set(
            coveredRows.map(r => {
                const d = new Date(r.publishDate);
                return `${d.toISOString().slice(0, 10)}:${r.platform}`;
            }),
        );

        // Check if there are any gaps (we can't know exact target — worker decides frequency)
        // We just enqueue a gap-fill run if today's date isn't fully covered across all platforms
        // The worker reads the draftHorizonDays and covered slots to decide what to generate
        if (covered.size < horizonDays) {
            // Don't enqueue if there's already a pending gap-fill for this assistant today
            const existingRun = await db
                .select({ id: taskRuns.id })
                .from(taskRuns)
                .where(and(
                    eq(taskRuns.assistantId, assistant.id),
                    eq(taskRuns.taskType, 'draft_gap_fill'),
                    eq(taskRuns.status, 'pending'),
                    gte(taskRuns.createdAt, new Date(now.getFullYear(), now.getMonth(), now.getDate())),
                ))
                .limit(1);

            if (!existingRun.length) {
                await db.insert(taskRuns).values({
                    userId: assistant.userId,
                    assistantId: assistant.id,
                    taskType: 'draft_gap_fill',
                    status: 'pending',
                    metadata: {
                        reason: 'daily_gap_check',
                        horizonDays,
                        windowEnd: windowEnd.toISOString(),
                        coveredSlots: covered.size,
                    },
                });
                enqueued++;
            }
        }
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ran: true, assistantsChecked: smmAssistants.length, gapFillRunsEnqueued: enqueued }),
    };
};
