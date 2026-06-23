// netlify/functions/poll-goal-telemetry.ts
// SMART Goals — Feature 4 / US4.1 + US1.2. Scheduled worker (hourly cron) that, for each
// active goal due a refresh, fetches the current metric value, appends a goal_telemetry row,
// and recomputes the goal's status via the run-rate engine.
//
//   AC4.1.1 tier-based cadence  — each goal polled at most once per its tier's cadence.
//   AC4.1.2 secure auth         — third-party tokens decrypted from the vault per request.
//   AC4.3.1 rate-limit backoff  — 429s retried with exponential backoff before giving up.
//   AC4.3.2 stale-data flag     — no fresh data for >48h flips the goal to data_disconnected.
//   AC4.3.3 alerting            — a critical_action notification fires when that happens.
//
// Owner-path (getDb) + manual org filter, like ingest-instagram-insights.

import { Handler } from '@netlify/functions';
import { and, eq, sql, inArray, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    goals, goalTelemetry, aiAssistants, systemConnections,
    scheduledPosts, leads, plans, masterPlans, notifications,
} from '../../db/schema';
import { getSecret } from '../../src/utils/vault';
import { getGoalMetric, pollCadenceHours, RUN_RATE_THRESHOLDS } from '../../src/config/goal-metrics';
import { computeGoalProgress } from '../../src/utils/goal-progress';

const GRAPH_VERSION = 'v19.0';
const BATCH = 200;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type FetchResult = { value: number | null; disconnected: boolean };

// ── Instagram account follower count (the one live third-party call) ────────────
async function fetchIgFollowers(igUserId: string, token: string): Promise<FetchResult> {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}?fields=followers_count&access_token=${token}`;
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(url);
        if (res.status === 429) {                       // AC4.3.1 — exponential backoff before retry
            await sleep(1000 * 2 ** attempt);
            continue;
        }
        if (res.status === 401 || res.status === 403) return { value: null, disconnected: true };
        if (!res.ok) return { value: null, disconnected: false };
        const body = await res.json().catch(() => null) as { followers_count?: number } | null;
        return { value: typeof body?.followers_count === 'number' ? body.followers_count : null, disconnected: false };
    }
    return { value: null, disconnected: false };         // exhausted retries — treat as transient, not disconnected
}

async function fetchMetric(db: any, goal: any, igConn: { externalUserId: string | null; vaultRefKey: string | null } | null): Promise<FetchResult> {
    const metric = getGoalMetric(goal.metricKey);
    if (!metric) return { value: null, disconnected: false };

    switch (goal.metricKey) {
        case 'instagram_followers': {
            if (!igConn?.externalUserId || !igConn.vaultRefKey) return { value: null, disconnected: true };
            const secret = await getSecret(db, igConn.vaultRefKey);
            const token = (secret?.token as string | undefined) ?? null;
            if (!token) return { value: null, disconnected: true };
            return fetchIgFollowers(igConn.externalUserId, token);
        }
        case 'instagram_reach': {
            const [row] = await db.execute(sql`
                SELECT COALESCE(SUM(reach), 0)::int AS v FROM post_insights
                WHERE assistant_id = ${goal.assistantId} AND organisation_id = ${goal.organisationId}
                  AND published_at >= now() - interval '30 days'`);
            return { value: Number((row as any)?.v ?? 0), disconnected: false };
        }
        case 'instagram_engagement_rate': {
            const [row] = await db.execute(sql`
                SELECT COALESCE(SUM(total_interactions),0)::float AS inter, COALESCE(SUM(reach),0)::float AS reach
                FROM post_insights
                WHERE assistant_id = ${goal.assistantId} AND organisation_id = ${goal.organisationId}
                  AND published_at >= now() - interval '30 days'`);
            const r = row as any;
            const rate = r && r.reach > 0 ? (r.inter / r.reach) * 100 : 0;
            return { value: Math.round(rate * 100) / 100, disconnected: false };
        }
        case 'qualified_leads': {
            // "Qualified" = leads that progressed to a won/converted state for this workspace.
            const [row] = await db
                .select({ v: sql<number>`count(*)::int` })
                .from(leads)
                .where(and(eq(leads.organisationId, goal.organisationId), eq(leads.status, 'converted')));
            return { value: Number(row?.v ?? 0), disconnected: false };
        }
        case 'content_published': {
            const [row] = await db
                .select({ v: sql<number>`count(*)::int` })
                .from(scheduledPosts)
                .where(and(eq(scheduledPosts.assistantId, goal.assistantId), eq(scheduledPosts.status, 'published')));
            return { value: Number(row?.v ?? 0), disconnected: false };
        }
        default:
            return { value: null, disconnected: false };
    }
}

export const handler: Handler = async () => {
    const db = getDb();
    const now = new Date();

    const activeGoals = await db
        .select()
        .from(goals)
        .where(eq(goals.isActive, true))
        .limit(BATCH);

    if (!activeGoals.length) return { statusCode: 200, body: JSON.stringify({ polled: 0 }) };

    // Per-org polling cadence (AC4.1.1) — one tier lookup per org.
    const orgIds = [...new Set(activeGoals.map(g => g.organisationId))];
    const tierRows = await db
        .select({ orgId: plans.organisationId, tierKey: masterPlans.tierKey })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(inArray(plans.organisationId, orgIds), eq(plans.status, 'active')));
    const tierByOrg = new Map<number, string | null>(tierRows.map(r => [r.orgId as number, r.tierKey]));

    // One Instagram connection per org (for follower polling).
    const igByOrg = new Map<number, { externalUserId: string | null; vaultRefKey: string | null }>();
    for (const orgId of orgIds) {
        const [conn] = await db
            .select({ externalUserId: systemConnections.externalUserId, vaultRefKey: systemConnections.vaultRefKey })
            .from(systemConnections)
            .where(and(
                eq(systemConnections.organisationId, orgId),
                eq(systemConnections.serviceName, 'instagram'),
                eq(systemConnections.status, 'active'),
                eq(systemConnections.isActive, true),
            ))
            .limit(1);
        if (conn) igByOrg.set(orgId, conn);
    }

    let polled = 0, disconnectedCount = 0, skipped = 0;

    await Promise.allSettled(activeGoals.map(async (goal) => {
        const cadenceMs = pollCadenceHours(tierByOrg.get(goal.organisationId)) * 3600_000;
        const lastAt = await db
            .select({ recordedAt: goalTelemetry.recordedAt })
            .from(goalTelemetry)
            .where(eq(goalTelemetry.goalId, goal.id))
            .orderBy(desc(goalTelemetry.recordedAt))
            .limit(1);
        const lastTelemetryAt: Date | null = lastAt[0]?.recordedAt ?? null;

        // Throttle by tier cadence.
        if (lastTelemetryAt && now.getTime() - lastTelemetryAt.getTime() < cadenceMs) { skipped++; return; }

        const { value, disconnected } = await fetchMetric(db, goal, igByOrg.get(goal.organisationId) ?? null);

        if (value != null) {
            const startValue = goal.startValue == null ? value : Number(goal.startValue);
            await db.insert(goalTelemetry).values({
                goalId: goal.id, organisationId: goal.organisationId, metricValue: String(value), source: 'poll',
            });
            const progress = computeGoalProgress({
                startValue,
                latestValue: value,
                targetValue: Number(goal.targetValue),
                createdAt: goal.createdAt,
                targetDate: goal.targetDate,
                direction: getGoalMetric(goal.metricKey)?.direction ?? 'increase',
                lastTelemetryAt: now,           // we just recorded a fresh point
                now,
            });
            await db.update(goals).set({
                latestValue: String(value),
                startValue: String(startValue),
                status: progress.status,
                statusUpdatedAt: now,
                updatedAt: now,
            }).where(eq(goals.id, goal.id));
            polled++;
            return;
        }

        // Couldn't fetch. If the connection is gone AND data is already stale, flag + alert (AC4.3.2/3).
        const staleCutoff = RUN_RATE_THRESHOLDS.staleDataHours * 3600_000;
        const isStale = !lastTelemetryAt || (now.getTime() - lastTelemetryAt.getTime() > staleCutoff);
        if (disconnected && isStale && goal.status !== 'data_disconnected') {
            await db.update(goals).set({ status: 'data_disconnected', statusUpdatedAt: now, updatedAt: now }).where(eq(goals.id, goal.id));
            disconnectedCount++;
            const metric = getGoalMetric(goal.metricKey);
            const integration = metric?.connectionService ? metric.connectionService.replace(/^\w/, c => c.toUpperCase()) : 'your data source';
            if (goal.createdByUserId) {
                await db.insert(notifications).values({
                    userId: goal.createdByUserId,
                    type: 'goal_data_disconnected',
                    title: 'Goal tracking paused',
                    message: `We lost connection to ${integration}. Please re-authenticate so your assistant can continue tracking its goals.`,
                    isRead: false,
                }).catch(() => {});
            }
        }
    }));

    return { statusCode: 200, body: JSON.stringify({ goals: activeGoals.length, polled, skipped, disconnected: disconnectedCount }) };
};
