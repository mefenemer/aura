import { Handler } from '@netlify/functions';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, goals } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    // Assistants are org-owned & member-shared — list everything in the active organisation.
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    try {
        // RLS-enforced: tenant-data queries run under withTenant (app_user + app.current_org).
        const assistants = await withTenant(orgId, (tx) => tx.select({
            id: aiAssistants.id,
            name: aiAssistants.name,
            role: aiAssistants.aiAssistantJobRole,
            // roleKey drives the connection-relevance map (connection-map.js).
            // Stored in configuration.type at creation (onboarding.ts).
            roleKey: sql<string | null>`(${aiAssistants.configuration} ->> 'type')`,
            status: aiAssistants.provisioningStatus,
            isActive: aiAssistants.isActive,
            // Canonical lifecycle state machine (assistant-lifecycle-epic).
            lifecycleStatus: aiAssistants.lifecycleStatus,
        }).from(aiAssistants).where(eq(aiAssistants.organisationId, orgId)));

        // SMART Goals AC2.1.1 — per-assistant goal status counts for the dashboard card micro-summary.
        // goals has no RLS (owner-path, like content_rules), so query it on the owner connection.
        const goalRows = await db
            .select({ assistantId: goals.assistantId, status: goals.status, c: sql<number>`count(*)::int` })
            .from(goals)
            .where(and(eq(goals.organisationId, orgId), eq(goals.isActive, true)))
            .groupBy(goals.assistantId, goals.status);

        const summary = new Map<number, { onTrack: number; offTrack: number; total: number }>();
        for (const r of goalRows) {
            const s = summary.get(r.assistantId) || { onTrack: 0, offTrack: 0, total: 0 };
            s.total += r.c;
            if (r.status === 'on_track') s.onTrack += r.c;
            else if (r.status !== 'pending') s.offTrack += r.c; // off_track | at_risk | data_disconnected
            summary.set(r.assistantId, s);
        }

        const withGoals = assistants.map(a => ({
            ...a,
            goalSummary: summary.get(a.id) || { onTrack: 0, offTrack: 0, total: 0 },
        }));

        return { statusCode: 200, body: JSON.stringify({ assistants: withGoals }) };
    } catch (e) {
        console.error("Fetch Assistants Error:", e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Database error' }) };
    }
};