// netlify/functions/process-content-jobs.ts
// US-SMM-3.1.1: Drains the content_generation_jobs queue every minute.
// Uses FOR UPDATE SKIP LOCKED to safely handle concurrent cron ticks.
// Calls Claude with the assembled blueprint, stores draft in scheduled_posts.

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { eq, and, lte, or, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    contentGenerationJobs, aiBlueprints, aiAssistants, organisations,
    scheduledPosts, notifications, users, auditLogs,
} from '../../db/schema';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const GEN_MODEL = 'claude-sonnet-4-6';

const BACKOFF_SECS = [10, 30, 90];

export const handler: Handler = async () => {
    const db = getDb();
    const now = new Date();

    // Claim queued jobs (or ones whose retry window has passed) — SKIP LOCKED prevents double-processing
    const jobs = await db.execute<{
        id: number; job_id: string; blueprint_id: number; assistant_id: number;
        organisation_id: number; user_id: number; attempt: number; max_attempts: number;
    }>(
        `SELECT id, job_id, blueprint_id, assistant_id, organisation_id, user_id, attempt, max_attempts
         FROM content_generation_jobs
         WHERE status = 'queued'
           AND (next_retry_at IS NULL OR next_retry_at <= now())
         ORDER BY created_at
         LIMIT 20
         FOR UPDATE SKIP LOCKED`
    );

    if (!jobs.rows.length) return { statusCode: 200, body: 'no jobs' };

    await Promise.allSettled(jobs.rows.map(job => processJob(db, job, now)));

    return { statusCode: 200, body: `processed ${jobs.rows.length} jobs` };
};

async function processJob(db: ReturnType<typeof getDb>, job: {
    id: number; job_id: string; blueprint_id: number; assistant_id: number;
    organisation_id: number; user_id: number; attempt: number; max_attempts: number;
}, now: Date) {
    // Mark as processing
    await db.execute(
        `UPDATE content_generation_jobs SET status = 'processing', attempt = attempt + 1, updated_at = now() WHERE id = ${job.id}`
    );

    try {
        // Fetch blueprint
        const [bp] = await db
            .select({ sections: aiBlueprints.sections })
            .from(aiBlueprints)
            .where(eq(aiBlueprints.id, job.blueprint_id))
            .limit(1);
        if (!bp) throw new Error('Blueprint not found');

        const sections = bp.sections as Record<string, { content: Record<string, unknown> }>;

        // Derive user instruction from blueprint sections 1 + 6
        const identity = sections['1-identity']?.content || {};
        const onboarding = sections['6-onboarding']?.content || {};
        const businessName = identity['businessName'] ?? 'this business';
        const audience = onboarding['targetAudience'] ?? 'their audience';
        const tone = onboarding['brandVoice'] ?? 'professional';

        const userInstruction = `Generate an Instagram post for ${businessName} targeting ${audience} in a ${tone} voice, following all strict and content rules in the system prompt. Return JSON: { "caption": "...", "hashtags": "...", "suggestedMediaDescription": "..." }`;

        // Build system prompt from blueprint sections
        let systemPrompt = `You are an expert social media copywriter.\n`;
        for (const [key, sec] of Object.entries(sections)) {
            systemPrompt += `\n--- ${key.toUpperCase()} ---\n`;
            for (const [k, v] of Object.entries(sec.content || {})) {
                if (v != null) systemPrompt += `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}\n`;
            }
        }

        const response = await anthropic.messages.create({
            model: GEN_MODEL,
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: 'user', content: userInstruction }],
        });

        const rawText = response.content.find(b => b.type === 'text')?.text || '';
        let generated: { caption?: string; hashtags?: string; suggestedMediaDescription?: string } = {};
        try {
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) generated = JSON.parse(jsonMatch[0]);
        } catch {
            generated = { caption: rawText };
        }

        // Store draft in scheduled_posts
        const [post] = await db.insert(scheduledPosts).values({
            userId: job.user_id,
            organisationId: job.organisation_id,
            assistantId: job.assistant_id,
            blueprintId: job.blueprint_id,
            jobId: job.job_id,
            platform: 'instagram',
            postFormat: 'image',
            publishDate: new Date(now.getTime() + 24 * 60 * 60 * 1000), // default: tomorrow
            caption: generated.caption ?? null,
            hashtags: generated.hashtags ?? null,
            suggestedMediaDescription: generated.suggestedMediaDescription ?? null,
            status: 'pending_approval',
            generatedAt: now,
        }).returning({ id: scheduledPosts.id });

        // Mark job completed
        await db.execute(
            `UPDATE content_generation_jobs SET status = 'completed', result_post_id = ${post.id}, updated_at = now() WHERE id = ${job.id}`
        );

        // Notify user
        const [asst] = await db.select({ name: aiAssistants.name }).from(aiAssistants).where(eq(aiAssistants.id, job.assistant_id)).limit(1);
        await db.insert(notifications).values({
            userId: job.user_id,
            type: 'post_draft_ready',
            title: `${asst?.name ?? 'Your assistant'}: Instagram post draft ready`,
            message: 'Your Instagram post draft is ready to review.',
            metadata: { jobId: job.job_id, postId: post.id },
        });

    } catch (err) {
        const attempt = job.attempt + 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[process-content-jobs] job ${job.job_id} attempt ${attempt} failed:`, errorMessage);

        if (attempt >= job.max_attempts) {
            // Final failure
            await db.execute(
                `UPDATE content_generation_jobs SET status = 'failed', error_message = '${errorMessage.replace(/'/g, "''")}', updated_at = now() WHERE id = ${job.id}`
            );
            await db.insert(notifications).values({
                userId: job.user_id,
                type: 'post_generation_failed',
                title: 'Post generation failed',
                message: 'We were unable to generate your post. Please try again or contact support if the issue persists.',
                metadata: { jobId: job.job_id, error: errorMessage },
            });
            await db.insert(auditLogs).values({ actionType: 'post_generation_failed', resourceType: 'content_generation_jobs', resourceId: job.job_id, userId: job.user_id, newState: { errorMessage, attempt } });
        } else {
            // Schedule retry with exponential backoff
            const backoffSecs = BACKOFF_SECS[attempt - 1] ?? 90;
            const nextRetryAt = new Date(Date.now() + backoffSecs * 1000).toISOString();
            await db.execute(
                `UPDATE content_generation_jobs SET status = 'queued', next_retry_at = '${nextRetryAt}', error_message = '${errorMessage.replace(/'/g, "''")}', updated_at = now() WHERE id = ${job.id}`
            );
        }
    }
}
