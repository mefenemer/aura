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
    saves: number | null;
    shares: number | null;
    comments: number | null;
};

function ratio(numerator: number | null, denominator: number | null): number | null {
    if (numerator === null || denominator === null || denominator === 0) return null;
    return numerator / denominator;
}

// US-SMM (AC8): weight bottom-line, intent-rich signals over vanity reach.
// Saves & Shares are the strongest organic conversion signals, comments next.
// A single value-weighted score lets the UI rank a low-reach/high-save post as a
// success rather than burying it under view-count.
const VALUE_WEIGHTS = { saves: 5, shares: 4, comments: 2 } as const;
function valueScore(t: Pick<Totals, 'saves' | 'shares' | 'comments'>): number | null {
    if (t.saves === null && t.shares === null && t.comments === null) return null;
    return (t.saves ?? 0) * VALUE_WEIGHTS.saves
        + (t.shares ?? 0) * VALUE_WEIGHTS.shares
        + (t.comments ?? 0) * VALUE_WEIGHTS.comments;
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
                saves: sql<number | null>`sum(${postInsights.saves})`,
                shares: sql<number | null>`sum(${postInsights.shares})`,
                comments: sql<number | null>`sum(${postInsights.comments})`,
            })
            .from(postInsights)
            .where(and(
                eq(postInsights.assistantId, aId),
                eq(postInsights.organisationId, orgId),
                gte(postInsights.publishedAt, prevStart),
                lt(postInsights.publishedAt, new Date(now)),
            ))
            .groupBy(isCurrent);

        const empty: Totals = { posts: 0, reach: null, interactions: null, linkClicks: null, saves: null, shares: null, comments: null };
        const num = (v: number | null) => v === null ? null : Number(v);
        const norm = (r: typeof rows[number] | undefined): Totals => r ? {
            posts: Number(r.posts) || 0,
            reach: num(r.reach),
            interactions: num(r.interactions),
            linkClicks: num(r.linkClicks),
            saves: num(r.saves),
            shares: num(r.shares),
            comments: num(r.comments),
        } : { ...empty };

        const current = norm(rows.find(r => Number(r.bucket) === 1));
        const previous = norm(rows.find(r => Number(r.bucket) === 0));

        const reachGrowth = ratio(
            current.reach !== null && previous.reach !== null ? current.reach - previous.reach : null,
            previous.reach,
        );

        // US-SMM (AC8): surface the posts that converted on VALUE (saves + shares) regardless of
        // reach, so a high-save / low-view post is recognised as a success. Ranked by value score.
        const valuePostRows = await db
            .select({
                postId: postInsights.scheduledPostId,
                platform: postInsights.platform,
                publishedAt: postInsights.publishedAt,
                reach: postInsights.reach,
                saves: postInsights.saves,
                shares: postInsights.shares,
                comments: postInsights.comments,
            })
            .from(postInsights)
            .where(and(
                eq(postInsights.assistantId, aId),
                eq(postInsights.organisationId, orgId),
                gte(postInsights.publishedAt, periodStart),
                lt(postInsights.publishedAt, new Date(now)),
            ));

        const periodMedianReach = (() => {
            const vals = valuePostRows.map(r => r.reach).filter((v): v is number => v != null).sort((a, b) => a - b);
            if (!vals.length) return null;
            const mid = Math.floor(vals.length / 2);
            return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
        })();

        const topValuePosts = valuePostRows
            .map(r => {
                const score = valueScore({ saves: r.saves, shares: r.shares, comments: r.comments });
                return {
                    postId: r.postId,
                    platform: r.platform,
                    publishedAt: r.publishedAt,
                    reach: r.reach,
                    saves: r.saves,
                    shares: r.shares,
                    comments: r.comments,
                    valueScore: score,
                    // Flag a genuine "punched above its reach" win: meaningful value despite
                    // below-median views — the kind of post vanity dashboards hide.
                    lowReachHighValue: score != null && score > 0
                        && periodMedianReach != null && r.reach != null
                        && r.reach < periodMedianReach,
                };
            })
            .filter(p => p.valueScore != null && p.valueScore > 0)
            .sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0))
            .slice(0, 5);

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
                    saves: current.saves,
                    shares: current.shares,
                    comments: current.comments,
                    valueScore: valueScore(current),
                },
                previous: {
                    posts: previous.posts,
                    reach: previous.reach,
                    valueScore: valueScore(previous),
                },
                metrics: {
                    // All ratios are 0–1 fractions; the frontend formats as a percentage.
                    engagementRate: ratio(current.interactions, current.reach),
                    reachGrowth,                       // can be negative; null if no prior reach
                    clickThroughRate: ratio(current.linkClicks, current.reach), // null for IG organic
                    // US-SMM (AC8): value-weighted signals — these are the headline numbers, with
                    // reach/CTR as supporting context rather than the score.
                    saveRate: ratio(current.saves, current.reach),
                    shareRate: ratio(current.shares, current.reach),
                    // Meaningful engagement = saves + shares + comments, weighed over likes/views.
                    meaningfulEngagementRate: ratio(
                        current.saves !== null || current.shares !== null || current.comments !== null
                            ? (current.saves ?? 0) + (current.shares ?? 0) + (current.comments ?? 0)
                            : null,
                        current.reach,
                    ),
                    valueScoreGrowth: ratio(
                        valueScore(current) !== null && valueScore(previous) !== null
                            ? (valueScore(current) ?? 0) - (valueScore(previous) ?? 0) : null,
                        valueScore(previous),
                    ),
                },
                topValuePosts,
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
