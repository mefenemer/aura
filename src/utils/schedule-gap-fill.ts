// src/utils/schedule-gap-fill.ts
// Posting Schedule gap-fill: given an assistant's posting schedule (frequency / days / times) and
// its draft horizon, compute the calendar slots that should be filled within the horizon, subtract
// what is already planned or in-flight, and enqueue one content_generation_job per remaining slot —
// each carrying target_publish_date so process-content-jobs stamps the draft at the right time.
//
// Shared by:
//   • draft-horizon-fill.ts        (daily cron — keeps every active SMM assistant's queue topped up)
//   • set-draft-horizon.ts         (horizon expanded — fill the newly-opened window immediately)

import { and, eq, gte, lte, desc, sql, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { getDb } from '../../db/client';
import { aiBlueprints, scheduledPosts, contentGenerationJobs } from '../../db/schema';
import { resolvePostingSchedule, computeScheduleSlots } from '../config/posting-cadence';

type Db = ReturnType<typeof getDb>;

export interface GapFillAssistant {
    id: number;
    userId: number;
    organisationId: number;
    name: string;
    onboardingContext: unknown;
    draftHorizonDays: number | null;
}

export interface GapFillResult {
    enqueued: number;
    /** Why nothing (or fewer) jobs were enqueued — useful for cron telemetry. */
    reason?: 'on_demand' | 'no_blueprint' | 'blocking_gaps' | 'fully_covered' | 'ok';
}

const UTC_DAY = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Enqueue generation jobs to fill any uncovered posting slots inside the assistant's draft horizon.
 * Idempotent in practice: a day already covered by a planned post or an in-flight job is skipped,
 * so repeated runs (cron + horizon change) won't double-book.
 */
export async function enqueueScheduleGapFill(
    db: Db,
    assistant: GapFillAssistant,
    now: Date = new Date(),
): Promise<GapFillResult> {
    const ctx = (assistant.onboardingContext as Record<string, unknown>) ?? {};
    const schedule = resolvePostingSchedule(ctx);
    const horizonDays = assistant.draftHorizonDays ?? 7;

    const slots = computeScheduleSlots({ schedule, horizonDays, now });
    if (!slots.length) return { enqueued: 0, reason: 'on_demand' };

    // Resolve the latest blueprint; skip if missing or it has blocking gaps (mirror generate-post).
    const [bp] = await db
        .select({ id: aiBlueprints.id, missingFields: aiBlueprints.missingFields })
        .from(aiBlueprints)
        .where(and(eq(aiBlueprints.assistantId, assistant.id), eq(aiBlueprints.organisationId, assistant.organisationId)))
        .orderBy(desc(aiBlueprints.compiledAt))
        .limit(1);
    if (!bp) return { enqueued: 0, reason: 'no_blueprint' };
    const blockingGaps = ((bp.missingFields as Array<{ severity: string }>) || []).filter(f => f.severity === 'blocking');
    if (blockingGaps.length > 0) return { enqueued: 0, reason: 'blocking_gaps' };

    const windowEnd = slots[slots.length - 1];

    // Posts already planned within the window, counted per calendar day.
    const plannedRows = await db
        .select({ publishDate: scheduledPosts.publishDate })
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.assistantId, assistant.id),
            gte(scheduledPosts.publishDate, now),
            lte(scheduledPosts.publishDate, windowEnd),
            sql`status IN ('draft','pending_approval','in_review','approved','scheduled')`,
        ));

    // Generation jobs still in flight that already target a slot in the window.
    const inflightRows = await db
        .select({ targetPublishDate: contentGenerationJobs.targetPublishDate })
        .from(contentGenerationJobs)
        .where(and(
            eq(contentGenerationJobs.assistantId, assistant.id),
            inArray(contentGenerationJobs.status, ['queued', 'processing']),
        ));

    // Per-day coverage counts (a day with two preferred times needs two posts to be "covered").
    const coverage = new Map<string, number>();
    const bump = (d: Date | null) => {
        if (!d) return;
        const key = UTC_DAY(new Date(d));
        coverage.set(key, (coverage.get(key) ?? 0) + 1);
    };
    plannedRows.forEach(r => bump(r.publishDate));
    inflightRows.forEach(r => bump(r.targetPublishDate));

    // Walk desired slots in chronological order; enqueue only the deficit per day.
    let enqueued = 0;
    for (const slot of slots) {
        const key = UTC_DAY(slot);
        const remaining = coverage.get(key) ?? 0;
        if (remaining > 0) { coverage.set(key, remaining - 1); continue; } // already covered

        await db.insert(contentGenerationJobs).values({
            jobId: randomUUID(),
            blueprintId: bp.id,
            assistantId: assistant.id,
            organisationId: assistant.organisationId,
            userId: assistant.userId,
            status: 'queued',
            attempt: 0,
            maxAttempts: 3,
            triggerType: 'scheduled',
            targetPublishDate: slot,
        });
        enqueued++;
    }

    return { enqueued, reason: enqueued ? 'ok' : 'fully_covered' };
}
