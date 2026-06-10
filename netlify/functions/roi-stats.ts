// netlify/functions/roi-stats.ts
// US-AUD-1.2.1: ROI aggregation — task runs × avg duration × hourly rate.
//
//  GET ?period=month|week
//   → { taskCount, hoursSaved, gbpSaved, planCostGbp, multiplier, period }

import { HandlerEvent } from '@netlify/functions';
import { eq, and, gte, count } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users, userProfiles, taskRuns, plans, masterPlans } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

// SC1: Default avg task duration per assistant type (minutes).
// Configurable per assistant in a future iteration; using flat default for now.
const AVG_TASK_DURATION_MINUTES = 30;

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
        // SC6: Count completed tasks in the period
        const [{ taskCount }] = await db
            .select({ taskCount: count() })
            .from(taskRuns)
            .where(and(
                eq(taskRuns.userId, userId),
                eq(taskRuns.status, 'completed'),
                gte(taskRuns.createdAt, periodStart)
            ));

        const completedTasks = Number(taskCount);

        // SC1: hours saved = taskCount × avgDuration(min) / 60
        const hoursSaved = parseFloat(((completedTasks * AVG_TASK_DURATION_MINUTES) / 60).toFixed(1));

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
        const [user] = await db
            .select({ organisationId: users.organisationId })
            .from(users)
            .where(eq(users.id, userId));

        let planCostGbp: number | null = null;
        if (user?.organisationId) {
            const [plan] = await db
                .select({ monthlyPriceGbp: masterPlans.monthlyPriceGbp })
                .from(plans)
                .innerJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
                .where(and(eq(plans.organisationId, user.organisationId), eq(plans.status, 'active')))
                .limit(1);
            if (plan?.monthlyPriceGbp) {
                planCostGbp = parseFloat(String(plan.monthlyPriceGbp));
            }
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
            const tasksNeeded = Math.ceil((hoursNeeded * 60) / AVG_TASK_DURATION_MINUTES);
            tasksToBreakEven = Math.max(0, tasksNeeded - completedTasks);
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                period,
                taskCount: completedTasks,
                hoursSaved,
                gbpSaved,
                planCostGbp,
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
