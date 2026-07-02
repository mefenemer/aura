// netlify/functions/roi-stats.ts
// US-AUD-1.2.1: ROI aggregation — task runs × avg duration × hourly rate.
//
//  GET ?period=month|week
//   → { taskCount, hoursSaved, gbpSaved, planCostGbp, multiplier, period }

import { HandlerEvent } from '@netlify/functions';
import { eq, and, gte, count } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users, userProfiles, taskRuns, scheduledPosts, plans, masterPlans, userOrganisations } from '../../db/schema';
import { getTimeMultipliers } from '../../src/utils/platform-config';

const jwtSecret = process.env.JWT_SECRET;

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };

    const rawCookies = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookies.split(';').map(c => {
            const [k, ...v] = c.trim().split('=');
            return [k, decodeURIComponent(v.join('='))];
        }).filter(([k]) => k !== '')
    );
    const sessionToken = cookies['aura_session'];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        const decoded = jwt.verify(sessionToken, jwtSecret) as { userId: number };
        userId = decoded.userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }

    const db = getDb();
    const period = (event.queryStringParameters?.period || 'month') as 'month' | 'week';

    // SC6: Date range — current calendar month or week
    const now = new Date();
    let periodStart: Date;
    if (period === 'week') {
        const dayOfWeek = now.getDay(); // 0=Sun
        periodStart = new Date(now);
        periodStart.setDate(now.getDate() - dayOfWeek);
        periodStart.setHours(0, 0, 0, 0);
    } else {
        periodStart = new Date(now.getFullYear(), now.getMonth(), 1); // start of month
    }

    try {
        // Resolve the user's organisation once — task/post activity is org-wide
        // (created by any teammate or by an assistant acting on the org's behalf),
        // not scoped to the single logged-in user.
        const [membership] = await db
            .select({ organisationId: userOrganisations.organisationId })
            .from(userOrganisations)
            .where(eq(userOrganisations.userId, userId));
        const organisationId = membership?.organisationId ?? null;

        // SC6: Count completed task runs and drafted/scheduled posts in the period.
        // Real assistant work (e.g. the social media assistant) is recorded in
        // scheduled_posts — task_runs alone is near-always empty for that flow, which
        // is why this widget previously showed zero despite an assistant being active
        // (see get-assistant-metrics.ts, which already reads from scheduled_posts).
        const [{ taskRunCount }] = organisationId ? await db
            .select({ taskRunCount: count() })
            .from(taskRuns)
            .where(and(
                eq(taskRuns.organisationId, organisationId),
                eq(taskRuns.status, 'completed'),
                gte(taskRuns.createdAt, periodStart)
            )) : [{ taskRunCount: 0 }];

        const [{ postCount }] = organisationId ? await db
            .select({ postCount: count() })
            .from(scheduledPosts)
            .where(and(
                eq(scheduledPosts.organisationId, organisationId),
                gte(scheduledPosts.createdAt, periodStart)
            )) : [{ postCount: 0 }];

        const completedTasks = Number(taskRunCount) + Number(postCount);

        // SC1: minutes saved per item — admin-configurable via gamification.time_multipliers,
        // shared with the dashboard "Hours Saved" widget (get-time-saved.ts) so both views
        // stay consistent. Task runs and drafted posts use their own multiplier.
        const mult = await getTimeMultipliers();
        const totalMinutes = Number(taskRunCount) * mult.tasks_completed + Number(postCount) * mult.content_drafted;
        const avgTaskDurationMinutes = completedTasks > 0 ? totalMinutes / completedTasks : mult.tasks_completed;

        // SC1: hours saved = total minutes / 60
        const hoursSaved = parseFloat((totalMinutes / 60).toFixed(1));

        // Get hourly rate from profile preferences
        const [profile] = await db
            .select({ preferences: userProfiles.preferences })
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .limit(1);
        const prefs = (profile?.preferences as Record<string, any>) || {};
        const hourlyRate = prefs.hourlyRateGbp ? parseFloat(String(prefs.hourlyRateGbp)) : null;

        const gbpSaved = hourlyRate ? parseFloat((hoursSaved * hourlyRate).toFixed(2)) : null;

        // Get plan cost for break-even calculation (SC2/SC3)
        let planCostGbp: number | null = null;
        let currency = 'GBP';
        if (organisationId) {
            const [plan] = await db
                .select({ monthlyPriceGbp: masterPlans.monthlyPriceGbp })
                .from(plans)
                .innerJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
                .where(and(eq(plans.organisationId, organisationId), eq(plans.status, 'active')))
                .limit(1);
            if (plan?.monthlyPriceGbp) {
                planCostGbp = parseFloat(String(plan.monthlyPriceGbp));
            }
            // masterPlans pricing is GBP-only (monthlyPriceGbp); currency stays 'GBP'.
        }

        // SC2: multiplier = gbpSaved / planCostGbp (only for monthly period)
        let multiplier: number | null = null;
        if (period === 'month' && gbpSaved !== null && planCostGbp !== null && planCostGbp > 0) {
            multiplier = parseFloat((gbpSaved / planCostGbp).toFixed(1));
        }

        // SC3: tasksToBreakEven — only if below break-even
        let tasksToBreakEven: number | null = null;
        if (period === 'month' && hourlyRate && planCostGbp && gbpSaved !== null && gbpSaved < planCostGbp) {
            const hoursNeeded = planCostGbp / hourlyRate;
            const tasksNeeded = Math.ceil((hoursNeeded * 60) / avgTaskDurationMinutes);
            tasksToBreakEven = Math.max(0, tasksNeeded - completedTasks);
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                period,
                taskCount: completedTasks,
                hoursSaved,
                gbpSaved,
                amountSaved: gbpSaved,    // US-I18N-2.1 SC5: currency-neutral alias — format with `currency`
                planCostGbp,
                planCost: planCostGbp,    // US-I18N-2.1 SC5: currency-neutral alias
                currency,                 // user's billing currency — use with Intl.NumberFormat
                multiplier,
                tasksToBreakEven,
                hourlyRateSet: hourlyRate !== null,
            }),
        };
    } catch (err) {
        console.error('roi-stats error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to compute ROI stats.' }) };
    }
};
