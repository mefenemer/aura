// netlify/functions/manage-goals.ts
// Epic: AI-Driven SMART Goals — Feature 1 (US1.1 Measurable Goal Creation).
// Per-assistant goal CRUD. Owner-path + manual org filter (no RLS) — same pattern as
// content-rules.ts / post_insights. Org is resolved via requireTenant (the JWT carries
// activeOrganisationId, NOT organisationId — see [[social-oauth-and-disclosure]]).
//
// GET    ?assistantId=N  → { goals: [...], availableMetrics: [...] }  (catalog gated by active connections — AC1.1.3)
// POST   { assistantId, metricKey, targetValue, targetDate, isPrimary? }  → create (AC1.1.2)
// PATCH  { id, targetValue?, targetDate?, isPrimary?, isActive? }  → update
// DELETE ?id=N  → delete

import { Handler } from '@netlify/functions';
import { and, eq, desc, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { goals, aiAssistants, systemConnections } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import {
    availableMetricsForConnections,
    getGoalMetric,
    isValidMetricKey,
} from '../../src/config/goal-metrics';

const json = (statusCode: number, payload: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
});

/** Active third-party services connected for this org (lowercased serviceName). */
async function connectedServices(db: any, orgId: number): Promise<string[]> {
    const rows = await db
        .selectDistinct({ serviceName: systemConnections.serviceName })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, orgId),
            eq(systemConnections.status, 'active'),
            eq(systemConnections.isActive, true),
        ));
    return rows.map((r: any) => String(r.serviceName).toLowerCase());
}

/** Verify the assistant exists and belongs to the caller's org. */
async function assertOwnedAssistant(db: any, assistantId: number, orgId: number): Promise<boolean> {
    const [row] = await db
        .select({ id: aiAssistants.id })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    return !!row;
}

export const handler: Handler = async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    const method = event.httpMethod;
    const params = event.queryStringParameters || {};

    // ── GET — goals for an assistant + the metric catalog gated by connections ──
    if (method === 'GET') {
        const assistantId = Number(params.assistantId);
        if (!assistantId || Number.isNaN(assistantId)) {
            return json(400, { error: 'assistantId is required.' });
        }
        if (!(await assertOwnedAssistant(db, assistantId, orgId))) {
            return json(404, { error: 'Assistant not found.' });
        }

        const rows = await db
            .select()
            .from(goals)
            .where(and(eq(goals.assistantId, assistantId), eq(goals.organisationId, orgId), eq(goals.isActive, true)))
            .orderBy(desc(goals.isPrimary), desc(goals.createdAt));

        const services = await connectedServices(db, orgId);
        return json(200, { goals: rows, availableMetrics: availableMetricsForConnections(services) });
    }

    // ── POST — create a goal ─────────────────────────────────────────────────
    if (method === 'POST') {
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const { assistantId, metricKey, targetValue, targetDate, isPrimary } = body;
        if (!assistantId || !metricKey || targetValue == null || !targetDate) {
            return json(400, { error: 'assistantId, metricKey, targetValue and targetDate are required.' });
        }
        if (!isValidMetricKey(metricKey)) {
            return json(400, { error: 'Unknown target metric.' });
        }
        const target = Number(targetValue);
        if (!Number.isFinite(target) || target <= 0) {
            return json(400, { error: 'targetValue must be a positive number.' });
        }
        const when = new Date(targetDate);
        if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
            return json(400, { error: 'targetDate must be a valid future date.' });
        }
        if (!(await assertOwnedAssistant(db, Number(assistantId), orgId))) {
            return json(404, { error: 'Assistant not found.' });
        }

        // AC1.1.3 — connection-backed metrics require the relevant service to be connected.
        const metric = getGoalMetric(metricKey)!;
        if (metric.source === 'connection' && metric.connectionService) {
            const services = await connectedServices(db, orgId);
            if (!services.includes(metric.connectionService)) {
                return json(409, {
                    error: `Connect ${metric.connectionService} before setting a "${metric.label}" goal.`,
                    code: 'METRIC_NOT_CONNECTED',
                });
            }
        }

        // Only one primary goal per assistant — demote the others first.
        if (isPrimary) {
            await db.update(goals)
                .set({ isPrimary: false, updatedAt: new Date() })
                .where(and(eq(goals.assistantId, Number(assistantId)), eq(goals.organisationId, orgId)));
        }

        const [created] = await db.insert(goals).values({
            organisationId: orgId,
            assistantId: Number(assistantId),
            metricKey,
            targetValue: String(target),
            targetDate: when,
            isPrimary: Boolean(isPrimary),
            status: 'pending',          // run-rate engine (Phase 2) assigns the rest once telemetry arrives
            createdByUserId: userId,
        }).returning();

        return json(201, { goal: created });
    }

    // ── PATCH — update a goal ────────────────────────────────────────────────
    if (method === 'PATCH') {
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const { id, targetValue, targetDate, isPrimary, isActive } = body;
        if (!id) return json(400, { error: 'id is required.' });

        const [existing] = await db.select().from(goals).where(eq(goals.id, Number(id))).limit(1);
        if (!existing || existing.organisationId !== orgId) return json(404, { error: 'Goal not found.' });

        const updates: Record<string, any> = { updatedAt: new Date() };
        if (targetValue !== undefined) {
            const t = Number(targetValue);
            if (!Number.isFinite(t) || t <= 0) return json(400, { error: 'targetValue must be a positive number.' });
            updates.targetValue = String(t);
        }
        if (targetDate !== undefined) {
            const when = new Date(targetDate);
            if (Number.isNaN(when.getTime())) return json(400, { error: 'targetDate is invalid.' });
            updates.targetDate = when;
        }
        if (isActive !== undefined) updates.isActive = Boolean(isActive);

        if (isPrimary === true) {
            await db.update(goals)
                .set({ isPrimary: false, updatedAt: new Date() })
                .where(and(eq(goals.assistantId, existing.assistantId), eq(goals.organisationId, orgId)));
            updates.isPrimary = true;
        } else if (isPrimary === false) {
            updates.isPrimary = false;
        }

        const [updated] = await db.update(goals).set(updates).where(eq(goals.id, Number(id))).returning();
        return json(200, { goal: updated });
    }

    // ── DELETE — remove a goal ───────────────────────────────────────────────
    if (method === 'DELETE') {
        const id = Number(params.id);
        if (!id || Number.isNaN(id)) return json(400, { error: 'id is required.' });

        const [existing] = await db.select({ orgId: goals.organisationId }).from(goals).where(eq(goals.id, id)).limit(1);
        if (!existing || existing.orgId !== orgId) return json(404, { error: 'Goal not found.' });

        await db.delete(goals).where(eq(goals.id, id));
        return json(200, { deleted: true, id });
    }

    return json(405, { error: 'Method Not Allowed' });
};
