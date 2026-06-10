// netlify/functions/first-task.ts
// US-AUD-1.1.1: First-task onboarding milestone management.
//
//  GET  → { milestoneComplete, starterTask, planActivatedAt }
//  POST { action: 'complete' | 'skip' } → records milestone or skip

import { HandlerEvent } from '@netlify/functions';
import { eq, and, count } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users, userProfiles, userMilestones, aiAssistants, taskRuns, plans } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

// SC2: Assistant-type-to-starter-task mappings
const STARTER_TASKS: Record<string, { title: string; description: string; placeholder: string }> = {
    'social-media-manager': {
        title: 'Generate 3 social captions',
        description: 'Let your assistant write 3 engaging social media captions for your business.',
        placeholder: 'Tell your assistant a bit about your business and what you want to promote…',
    },
    'content-writer': {
        title: 'Write a short blog intro',
        description: 'Have your assistant draft a compelling introduction for a blog post.',
        placeholder: 'What topic would you like a blog post about?',
    },
    'email-marketing': {
        title: 'Draft a marketing email',
        description: 'Let your assistant craft a persuasive marketing email for your audience.',
        placeholder: 'What product, promotion, or update would you like to announce?',
    },
    // Default for all other/custom assistants
    _default: {
        title: 'Run your first task',
        description: 'Describe a task for your assistant and see what it can do for you.',
        placeholder: 'What would you like your assistant to help with?',
    },
};

export const handler = async (event: HandlerEvent) => {
    if (!['GET', 'POST'].includes(event.httpMethod)) return { statusCode: 405, body: 'Method Not Allowed' };
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

    // GET: Return milestone state + starter task recommendation
    if (event.httpMethod === 'GET') {
        const [milestone] = await db
            .select()
            .from(userMilestones)
            .where(and(eq(userMilestones.userId, userId), eq(userMilestones.milestone, 'first_task_complete')))
            .limit(1);

        const [skipped] = await db
            .select()
            .from(userMilestones)
            .where(and(eq(userMilestones.userId, userId), eq(userMilestones.milestone, 'first_task_skipped')))
            .limit(1);

        // Get user's first assistant to determine starter task (SC2)
        const [assistant] = await db
            .select({ aiAssistantJobRole: aiAssistants.aiAssistantJobRole, masterAssistantId: aiAssistants.masterAssistantId })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.userId, userId), eq(aiAssistants.isActive, true)))
            .limit(1);

        const roleKey = assistant?.aiAssistantJobRole?.toLowerCase().replace(/\s+/g, '-') || '_default';
        const starterTask = STARTER_TASKS[roleKey] || STARTER_TASKS._default;

        // SC5: Get plan activation time for time_to_first_task_complete metric
        const [plan] = await db
            .select({ startedAt: plans.startedAt })
            .from(plans)
            .where(eq(plans.userId, userId))
            .orderBy(plans.startedAt)
            .limit(1);

        return {
            statusCode: 200,
            body: JSON.stringify({
                milestoneComplete: !!milestone,
                milestoneSkipped: !!skipped,
                completedAt: milestone?.completedAt || null,
                planActivatedAt: plan?.startedAt || null,
                starterTask,
            }),
        };
    }

    // POST: Record milestone completion or skip
    if (event.httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { action } = body;

        if (action === 'complete') {
            // SC4: Record milestone
            try {
                await db.insert(userMilestones).values({
                    userId,
                    milestone: 'first_task_complete',
                    metadata: {},
                }).onConflictDoNothing();
            } catch { /* already exists */ }

            // SC5: Record time_to_first_task_complete
            try {
                const [plan] = await db
                    .select({ startedAt: plans.startedAt })
                    .from(plans)
                    .where(eq(plans.userId, userId))
                    .orderBy(plans.startedAt)
                    .limit(1);

                if (plan?.startedAt) {
                    const secondsElapsed = Math.round((Date.now() - new Date(plan.startedAt).getTime()) / 1000);
                    await db.insert(userMilestones).values({
                        userId,
                        milestone: 'time_to_first_task_complete',
                        metadata: { secondsElapsed },
                    }).onConflictDoUpdate({
                        target: [userMilestones.userId, userMilestones.milestone],
                        set: { metadata: { secondsElapsed }, completedAt: new Date() },
                    });
                }
            } catch { /* non-critical metric */ }

            return { statusCode: 200, body: JSON.stringify({ success: true, action: 'complete' }) };
        }

        if (action === 'skip') {
            try {
                await db.insert(userMilestones).values({
                    userId,
                    milestone: 'first_task_skipped',
                    metadata: {},
                }).onConflictDoNothing();
            } catch { /* already exists */ }
            return { statusCode: 200, body: JSON.stringify({ success: true, action: 'skip' }) };
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'action must be "complete" or "skip".' }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};
