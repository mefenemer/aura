// src/utils/orchestration.ts
// Orchestration runtime (Phase 5) — fires cross-assistant hand-offs.
//
// When a SOURCE assistant fires a SOURCE_EVENT (drafts/publishes a post), each active
// orchestration_link hands off to its TARGET assistant by enqueuing a content_generation_job
// (the existing pipeline then produces a pending_approval draft in the target's queue). Every
// firing is logged to orchestration_runs (idempotent via UNIQUE(link_id, source_post_id)) and
// a notification is raised.
//
// Best-effort by contract: this NEVER throws to its caller — a hand-off failure must not break
// the draft/publish flow that triggered it. Callers should still `await` it inside their own
// try/catch or fire-and-forget wrapper.

import { randomUUID } from 'crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    orchestrationLinks,
    orchestrationRuns,
    contentGenerationJobs,
    aiBlueprints,
    aiAssistants,
    notifications,
} from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export type OrchestrationEvent = 'drafts_a_post' | 'publishes_a_post' | 'completes_a_task';

export interface FireOrchestrationsOpts {
    sourceAssistantId: number;
    orgId: number;
    userId: number;
    event: OrchestrationEvent;
    sourcePostId?: number | null;   // the post whose draft/publish triggered the hand-off
    sourceCaption?: string | null;  // grounds the target's generation
}

export async function fireOrchestrations(db: Db, opts: FireOrchestrationsOpts): Promise<void> {
    const { sourceAssistantId, orgId, userId, event, sourcePostId = null, sourceCaption = null } = opts;
    try {
        // 1. Active links from this source for this event.
        const links = await db.select().from(orchestrationLinks).where(and(
            eq(orchestrationLinks.organisationId, orgId),
            eq(orchestrationLinks.sourceAssistantId, sourceAssistantId),
            eq(orchestrationLinks.sourceEvent, event),
            eq(orchestrationLinks.isActive, true),
        ));
        if (!links.length) return;

        // Resolve assistant names once (source + all targets) for the notification copy.
        const ids = Array.from(new Set([sourceAssistantId, ...links.map(l => l.targetAssistantId)]));
        const names = await db.select({ id: aiAssistants.id, name: aiAssistants.name })
            .from(aiAssistants).where(inArray(aiAssistants.id, ids));
        const nameById = new Map(names.map(n => [n.id, n.name] as const));
        const sourceName = nameById.get(sourceAssistantId) ?? 'An assistant';

        for (const link of links) {
            // 2. Idempotent claim: one run per (link, triggering post). A second firing for the
            //    same post (e.g. a retry) conflicts and returns [] → we skip it entirely.
            const [run] = await db.insert(orchestrationRuns).values({
                organisationId:    orgId,
                linkId:            link.id,
                sourceAssistantId,
                targetAssistantId: link.targetAssistantId,
                sourceEvent:       event,
                sourcePostId,
                status:            'handed_off',
            }).onConflictDoNothing().returning({ id: orchestrationRuns.id });
            if (!run) continue; // already fired for this post

            // 3. Enqueue a draft for the target (reuses the generation pipeline). Requires the
            //    target's compiled blueprint; if it has none yet, we still record the hand-off
            //    (run row + notification) but produce no draft.
            const [bp] = await db.select({ id: aiBlueprints.id })
                .from(aiBlueprints)
                .where(and(
                    eq(aiBlueprints.assistantId, link.targetAssistantId),
                    eq(aiBlueprints.organisationId, orgId),
                ))
                .orderBy(desc(aiBlueprints.compiledAt))
                .limit(1);

            let jobId: string | null = null;
            if (bp) {
                jobId = randomUUID();
                const snippet = (sourceCaption || '').trim().slice(0, 300);
                const contextPrompt = `${link.targetAction}. Context from ${sourceName}'s post${snippet ? `: "${snippet}"` : ''}.`.slice(0, 500);
                await db.insert(contentGenerationJobs).values({
                    jobId,
                    blueprintId:    bp.id,
                    assistantId:    link.targetAssistantId,
                    organisationId: orgId,
                    userId,
                    status:         'queued',
                    attempt:        0,
                    maxAttempts:    3,
                    contextPrompt,
                    triggerType:    'orchestration',   // loop guard: this draft won't re-fire orchestration
                });
                await db.update(orchestrationRuns).set({ targetJobId: jobId }).where(eq(orchestrationRuns.id, run.id));
            }

            // 4. Tell the user a hand-off happened (non-critical).
            const targetName = nameById.get(link.targetAssistantId) ?? 'another assistant';
            try {
                await db.insert(notifications).values({
                    userId,
                    type:    'orchestration_handoff',
                    title:   `${sourceName} handed off to ${targetName}`,
                    message: `${targetName} is now working on: ${link.targetAction}.`,
                    metadata: { linkId: link.id, runId: run.id, sourcePostId, targetJobId: jobId },
                });
            } catch { /* notification failure must not abort the remaining hand-offs */ }
        }
    } catch (err) {
        // Never surface to the caller — a hand-off must not break the draft/publish flow.
        console.error('[fireOrchestrations] error', err);
    }
}
