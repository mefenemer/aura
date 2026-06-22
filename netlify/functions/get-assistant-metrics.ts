// get-assistant-metrics.ts
// GET ?id=<assistantId>&days=<window>   (days optional, default 30)
//
// US-SMM-PERF: Aggregates post_insights for one assistant over a period and the
// immediately-preceding period of equal length, deriving the three headline
// "Performance Metrics" cards on the assistant detail page:
//
//   Engagement Rate     = totalInteractions / reach        (this period)
//   Organic Reach Growth= (reach − prevReach) / prevReach  (period-over-period)
//   Click-Through Rate  = linkClicks / reach               (null for IG organic)
//
// Returns nulls — never zeros — where a platform doesn't expose a metric, so the
// UI can honestly render "—" instead of a misleading 0%.

import { Handler } from '@netlify/functions';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { postInsights, aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const DAY_MS = 24 * 60 * 60 * 1000;

type Totals = {
    posts: number;
    reach: number | null;
    interactions: number | null;
    linkClicks: number | null;
};

function ratio(numerator: number | null, denominator: number | null): number | null {
    if (numerator === null || denominator === null || denominator === 0) return null;
    return numerator / denominator;
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const assistantId = event.queryStringParameters?.id;
    if (!assistantId || Number.isNaN(parseInt(assistantId))) {
        return { statusCode: 400, body: JSON.stringify({ error: 'id parameter is required.' }) };
    }
    const days = Math.min(Math.max(parseInt(event.queryStringParameters?.days || '30') || 30, 1), 365);

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    const aId = parseInt(assistantId);
    const now = Date.now();
    const periodStart = new Date(now - days * DAY_MS);
    const prevStart = new Date(now - 2 * days * DAY_MS);

    try {
        // ── IDOR guard: the assistant must belong to the caller's organisation (RLS-enforced) ──
        const owned = await withTenant(orgId, async (tx) => {
            const [row] = await tx
                .select({ id: aiAssistants.id })
                .from(aiAssistants)
                .where(and(eq(aiAssistants.id, aId), eq(aiAssistants.organisationId, orgId)))
                .limit(1);
            return row ?? null;
        });
        if (!owned) {
            // 404 (not 403) so we don't leak whether the assistant exists.
            return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
        }

        // Sum each period in a single grouped query. COUNT is always a number;
        // SUMs come back null when every row's column is null (metric unsupported).
        const isCurrent = sql<number>`case when ${postInsights.publishedAt} >= ${periodStart} then 1 else 0 end`;
        const rows = await db
            .select({
                bucket: isCurrent,
                posts: sql<number>`count(*)`,
                reach: sql<number | null>`sum(${postInsights.reach})`,
                interactions: sql<number | null>`sum(${postInsights.totalInteractions})`,
                linkClicks: sql<number | null>`sum(${postInsights.linkClicks})`,
            })
            .from(postInsights)
            .where(and(
                eq(postInsights.assistantId, aId),
                eq(postInsights.organisationId, orgId),
                gte(postInsights.publishedAt, prevStart),
                lt(postInsights.publishedAt, new Date(now)),
            ))
            .groupBy(isCurrent);

        const empty: Totals = { posts: 0, reach: null, interactions: null, linkClicks: null };
        const norm = (r: typeof rows[number] | undefined): Totals => r ? {
            posts: Number(r.posts) || 0,
            reach: r.reach === null ? null : Number(r.reach),
            interactions: r.interactions === null ? null : Number(r.interactions),
            linkClicks: r.linkClicks === null ? null : Number(r.linkClicks),
        } : { ...empty };

        const current = norm(rows.find(r => Number(r.bucket) === 1));
        const previous = norm(rows.find(r => Number(r.bucket) === 0));

        const reachGrowth = ratio(
            current.reach !== null && previous.reach !== null ? current.reach - previous.reach : null,
            previous.reach,
        );

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                periodDays: days,
                hasData: current.posts > 0 || previous.posts > 0,
                current: {
                    posts: current.posts,
                    reach: current.reach,
                    interactions: current.interactions,
                    linkClicks: current.linkClicks,
                },
                previous: {
                    posts: previous.posts,
                    reach: previous.reach,
                },
                metrics: {
                    // All ratios are 0–1 fractions; the frontend formats as a percentage.
                    engagementRate: ratio(current.interactions, current.reach),
                    reachGrowth,                       // can be negative; null if no prior reach
                    clickThroughRate: ratio(current.linkClicks, current.reach), // null for IG organic
                },
            }),
        };
    } catch (err: any) {
        // Performance Metrics are a SUPPLEMENTARY panel — a failure here must never break the
        // assistant detail page. Degrade gracefully to "no data" for ANY error (table not yet
        // migrated, RLS/connection hiccup, a brand-new assistant with no insights, etc.) and log
        // the real cause server-side for diagnosis rather than surfacing a 500 to the client.
        console.error('[get-assistant-metrics] degraded to no-data after error:', err?.code || '', err?.message || err);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ periodDays: days, hasData: false, current: {}, previous: {}, metrics: {} }),
        };
    }
};
