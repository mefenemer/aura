// netlify/functions/autonomous-goal-optimizer.ts
// SMART Goals — US3.3 Autonomous Optimization Mode (highest tier). Daily cron: for each
// assistant with autonomousGoalSeeking ON whose org is still on an eligible tier, if any goal
// is off_track (AC3.3.2) the LLM rewrites an allowed brief param (brand voice / tone). The
// change is applied, written to the audit log, and surfaced as a notification (AC3.3.3).
//
// Only 'tone_of_voice' is auto-editable for now — a deliberately small, low-risk allow-list.

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, goals, auditLogs, notifications } from '../../db/schema';
import { getActiveTierKeyByOrg } from '../../src/utils/plan-features';
import { tierAllows } from '../../src/config/goal-metrics';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { gatewayGenerate } from '../../src/lib/ai-gateway';

const BATCH = 50;

export const handler: Handler = async () => {
    if (await isGlobalAiDisabled()) return { statusCode: 200, body: JSON.stringify({ skipped: 'ai_disabled' }) };
    const db = getDb();

    const candidates = await db
        .select({
            id: aiAssistants.id, name: aiAssistants.name, role: aiAssistants.aiAssistantJobRole,
            organisationId: aiAssistants.organisationId, userId: aiAssistants.userId, configuration: aiAssistants.configuration,
        })
        .from(aiAssistants)
        .where(eq(aiAssistants.autonomousGoalSeeking, true))
        .limit(BATCH);

    let adjusted = 0;
    const tierAllowedByOrg = new Map<number, boolean>();

    for (const a of candidates) {
        // Eligibility can lapse after a downgrade — re-check the tier each run.
        let allowed = tierAllowedByOrg.get(a.organisationId);
        if (allowed === undefined) {
            allowed = tierAllows('autonomous', await getActiveTierKeyByOrg(db, a.organisationId));
            tierAllowedByOrg.set(a.organisationId, allowed);
        }
        if (!allowed) continue;

        const offTrack = await db
            .select({ id: goals.id })
            .from(goals)
            .where(and(
                eq(goals.assistantId, a.id),
                eq(goals.organisationId, a.organisationId),
                eq(goals.status, 'off_track'),
                eq(goals.isActive, true),
            ))
            .limit(1);
        if (!offTrack.length) continue;

        const cfg = (a.configuration as any) || {};
        const inputs = cfg.inputs || {};
        const currentTone: string = inputs.tone_of_voice || '';

        let newTone = '';
        try {
            const { text } = await gatewayGenerate({
                system: `An AI ${a.role || 'assistant'} is off-track on its growth goal. Rewrite ONLY its brand voice / tone `
                    + `to better drive engagement toward the goal. Respond with the new tone description only — one or two `
                    + `sentences, no preamble, no quotes.`,
                messages: [{ role: 'user', content: `Current tone: ${currentTone || '(unset)'}` }],
                maxTokens: 200,
            });
            newTone = text.trim();
        } catch { continue; }
        if (!newTone || newTone === currentTone) continue;

        const newCfg = { ...cfg, inputs: { ...inputs, tone_of_voice: newTone } };
        await db.update(aiAssistants).set({ configuration: newCfg }).where(eq(aiAssistants.id, a.id));

        // AC3.3.3 — audit trail + user notification.
        await db.insert(auditLogs).values({
            userId: a.userId,
            actionType: 'AUTONOMOUS_OPTIMIZE',
            resourceType: 'ai_assistants',
            resourceId: String(a.id),
            previousState: { tone_of_voice: currentTone },
            newState: { tone_of_voice: newTone },
        }).catch(() => {});
        await db.insert(notifications).values({
            userId: a.userId,
            type: 'goal_autonomous_adjustment',
            title: 'Autonomous adjustment made',
            message: `Assistant ${a.name} automatically adjusted its Brand Voice to improve engagement. View Changes.`,
            isRead: false,
        }).catch(() => {});
        adjusted++;
    }

    return { statusCode: 200, body: JSON.stringify({ candidates: candidates.length, adjusted }) };
};
