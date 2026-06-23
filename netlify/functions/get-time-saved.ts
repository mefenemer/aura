// netlify/functions/get-time-saved.ts
// US2.1 — "Hours Saved" calculator. Counts the org's AI actions this calendar
// month (leads generated, content drafted, completed task runs), multiplies each
// by the admin-configured minute value (gamification.time_multipliers), and
// returns the total hours plus a per-assistant breakdown (AC2.1.1–2.1.3).

import { Handler } from '@netlify/functions';
import { and, count, eq, gte } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { leads, scheduledPosts, taskRuns, aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { getTimeMultipliers } from '../../src/utils/platform-config';
import { evaluateMilestones } from '../../src/utils/gamification';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const mult = await getTimeMultipliers();

    const [leadsRows, postsByAssistant, tasksByAssistant, assistants] = await Promise.all([
        db.select({ n: count() }).from(leads)
            .where(and(eq(leads.organisationId, orgId), gte(leads.createdAt, monthStart))),
        db.select({ assistantId: scheduledPosts.assistantId, n: count() }).from(scheduledPosts)
            .where(and(eq(scheduledPosts.organisationId, orgId), gte(scheduledPosts.createdAt, monthStart)))
            .groupBy(scheduledPosts.assistantId),
        db.select({ assistantId: taskRuns.assistantId, n: count() }).from(taskRuns)
            .where(and(eq(taskRuns.organisationId, orgId), eq(taskRuns.status, 'completed'), gte(taskRuns.createdAt, monthStart)))
            .groupBy(taskRuns.assistantId),
        db.select({ id: aiAssistants.id, name: aiAssistants.name, role: aiAssistants.aiAssistantJobRole })
            .from(aiAssistants).where(eq(aiAssistants.organisationId, orgId)),
    ]);

    const leadsCount = Number(leadsRows[0]?.n ?? 0);

    // Per-assistant minutes from drafts + completed tasks.
    const nameById = new Map(assistants.map(a => [a.id, a.name || a.role || 'Assistant']));
    const minutesByAssistant = new Map<number, number>();
    const countByAssistant = new Map<number, number>(); // # of counted items (posts + tasks)
    const addMinutes = (id: number | null, mins: number) => {
        if (id == null || mins <= 0) return;
        minutesByAssistant.set(id, (minutesByAssistant.get(id) ?? 0) + mins);
    };
    const addCount = (id: number | null, n: number) => {
        if (id == null || n <= 0) return;
        countByAssistant.set(id, (countByAssistant.get(id) ?? 0) + n);
    };
    postsByAssistant.forEach(r => { addMinutes(r.assistantId, Number(r.n) * mult.content_drafted); addCount(r.assistantId, Number(r.n)); });
    tasksByAssistant.forEach(r => { addMinutes(r.assistantId, Number(r.n) * mult.tasks_completed); addCount(r.assistantId, Number(r.n)); });

    const breakdown: { label: string; hours: number }[] = [];
    // Leads roll up to an org-level line (the leads table has no assistant attribution).
    const leadMinutes = leadsCount * mult.leads_generated;
    if (leadMinutes > 0) breakdown.push({ label: 'Lead Generation', hours: round1(leadMinutes / 60) });
    for (const [id, mins] of minutesByAssistant.entries()) {
        breakdown.push({ label: nameById.get(id) ?? `Assistant #${id}`, hours: round1(mins / 60) });
    }
    breakdown.sort((a, b) => b.hours - a.hours);

    const totalMinutes = leadMinutes + Array.from(minutesByAssistant.values()).reduce((s, m) => s + m, 0);

    // Itemised counts behind the savings number — drives the "what tasks count?" modal (#3).
    // Each line is a counted source this month with how many items + the hours they saved.
    const tasks: { label: string; count: number; hours: number }[] = [];
    if (leadsCount > 0) tasks.push({ label: 'Leads generated', count: leadsCount, hours: round1(leadMinutes / 60) });
    for (const [id, n] of countByAssistant.entries()) {
        tasks.push({ label: nameById.get(id) ?? `Assistant #${id}`, count: n, hours: round1((minutesByAssistant.get(id) ?? 0) / 60) });
    }
    tasks.sort((a, b) => b.count - a.count);
    const taskCount = leadsCount + Array.from(countByAssistant.values()).reduce((s, n) => s + n, 0);

    // US3.1: evaluate milestones on dashboard load (idempotent; honours the emergency stop). Non-blocking.
    await evaluateMilestones(db, orgId, ctx.userId).catch(() => {});

    return json(200, {
        hoursSaved: Math.round(totalMinutes / 60),
        totalMinutes,
        month: monthStart.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
        breakdown,
        tasks,
        taskCount,
    });
};

function round1(n: number): number { return Math.round(n * 10) / 10; }
