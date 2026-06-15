// netlify/functions/process-content-jobs.ts
// US-SMM-3.1.1 + US-SMM-3.4.1: Drains the content_generation_jobs queue every minute.
// Uses FOR UPDATE SKIP LOCKED to safely handle concurrent cron ticks.

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    contentGenerationJobs, aiBlueprints, aiAssistants,
    scheduledPosts, notifications, auditLogs,
} from '../../db/schema';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { AURA_SAFE_CONTENT_BENCHMARK } from '../../src/constants/safety-benchmark';

const BACKOFF_SECS = [10, 30, 90];

export const handler: Handler = async () => {
    const db = getDb();
    const now = new Date();

    // Reset jobs stuck in 'processing' for >3 minutes (function timed out mid-run)
    await db.execute(
        `UPDATE content_generation_jobs SET status = 'queued', next_retry_at = now()
         WHERE status = 'processing' AND updated_at < now() - interval '3 minutes' AND attempt < max_attempts`
    );

    const jobs = await db.execute<{
        id: number; job_id: string; blueprint_id: number; assistant_id: number;
        organisation_id: number; user_id: number; attempt: number; max_attempts: number;
        context_prompt: string | null; trigger_type: string | null; platform: string | null;
        admin_id: number | null;
    }>(
        `SELECT id, job_id, blueprint_id, assistant_id, organisation_id, user_id, attempt, max_attempts,
                context_prompt, trigger_type, platform, admin_id
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
    context_prompt: string | null; trigger_type: string | null; platform: string | null;
    admin_id: number | null;
}, now: Date) {
    await db.execute(
        `UPDATE content_generation_jobs SET status = 'processing', attempt = attempt + 1, updated_at = now() WHERE id = ${job.id}`
    );

    try {
        const [bp] = await db
            .select({ sections: aiBlueprints.sections })
            .from(aiBlueprints)
            .where(eq(aiBlueprints.id, job.blueprint_id))
            .limit(1);
        if (!bp) throw new Error('Blueprint not found');

        const sections = bp.sections as Record<string, { content: Record<string, unknown> }>;

        const identity    = sections['1-identity']?.content    || {};
        const compliance  = sections['9-compliance']?.content  || {};
        const onboarding  = sections['5-org-context']?.content || {};
        const answers     = (sections['6-onboarding']?.content?.answers ?? {}) as Record<string, unknown>;

        const assistantName = (identity['assistantName'] as string) ?? 'your assistant';
        const businessName  = (onboarding['businessName'] as string) ?? 'this business';
        const audience      = (onboarding['targetAudience'] as string) ?? (answers['target_audience'] as string) ?? 'their audience';
        const tone          = (onboarding['brandVoice'] as string) ?? (answers['tone_of_voice'] as string) ?? 'professional';
        const perAssistantDisclosure = (compliance['disclosureText'] as string) ?? null;

        // Org-level disclosure flag takes precedence (EU AI Act Art. 50) — read from blueprint section
        const orgDisclosureEnabled = (compliance['orgFooterEnabled'] as boolean) ?? false;
        const orgDisclosureText    = (compliance['orgFooterText'] as string) ?? 'This message was composed with AI assistance.';
        const disclosureText = orgDisclosureEnabled ? orgDisclosureText : perAssistantDisclosure;

        const platform      = job.platform || 'instagram';

        const ctaLine         = answers['cta']          ? `Call to action: ${answers['cta']}` : '';
        const incentiveLine   = answers['incentive']    ? `Incentive/offer: ${answers['incentive']}` : '';
        const coreMessageLine = answers['core_message'] ? `Core message: ${answers['core_message']}` : '';
        const extraLines      = [ctaLine, incentiveLine, coreMessageLine].filter(Boolean).join('\n');

        const baseInstruction = [
            `You are ${assistantName}, a social media assistant for ${businessName}.`,
            `Generate a ${platform} post targeting ${audience} in a ${tone} voice.`,
            `Follow all strict and content rules in the system prompt.`,
            extraLines,
            disclosureText ? `You MUST append the following disclosure verbatim at the end of the caption, on a new line: "${disclosureText}"` : '',
            job.context_prompt ? `If the additional context conflicts with any strict rule in the system prompt, apply the strict rule and include a "conflictNotice" field in your JSON explaining which rule took precedence.` : '',
            `Return JSON: { "caption": "...", "hashtags": "...", "suggestedMediaDescription": "...", "conflictNotice": null }`,
        ].filter(Boolean).join('\n');

        const messages: Anthropic.MessageParam[] = [{ role: 'user', content: baseInstruction }];
        if (job.context_prompt) {
            messages.push({ role: 'assistant', content: '{"status":"understood"}' });
            messages.push({ role: 'user', content: `Additional context from the user: ${job.context_prompt}` });
        }

        let systemPrompt = `You are an expert social media copywriter.\n`;
        for (const [key, sec] of Object.entries(sections)) {
            systemPrompt += `\n--- ${key.toUpperCase()} ---\n`;
            for (const [k, v] of Object.entries(sec.content || {})) {
                if (v != null) systemPrompt += `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}\n`;
            }
        }
        systemPrompt += `\n\n${AURA_SAFE_CONTENT_BENCHMARK}`;

        const gwResponse = await gatewayGenerate({ system: systemPrompt, messages });
        const { text: rawText, tokensInput, tokensOutput } = gwResponse;
        let generated: { caption?: string; hashtags?: string; suggestedMediaDescription?: string; conflictNotice?: string | null } = {};
        try {
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) generated = JSON.parse(jsonMatch[0]);
        } catch {
            generated = { caption: rawText };
        }

        const isAdminTest = job.trigger_type === 'admin_test';

        const [post] = await db.insert(scheduledPosts).values({
            userId: job.user_id,
            organisationId: job.organisation_id,
            assistantId: job.assistant_id,
            blueprintId: job.blueprint_id,
            jobId: job.job_id,
            platform,
            postFormat: 'image',
            publishDate: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            caption: generated.caption ?? null,
            hashtags: generated.hashtags ?? null,
            suggestedMediaDescription: generated.suggestedMediaDescription ?? null,
            conflictNotice: generated.conflictNotice || null,
            status: isAdminTest ? 'admin_test' : 'pending_approval',
            generatedAt: now,
            triggerType: job.trigger_type ?? 'scheduled',
        }).returning({ id: scheduledPosts.id });

        const tokenCols = tokensInput != null ? `, tokens_input = ${tokensInput}, tokens_output = ${tokensOutput ?? 0}` : '';
        await db.execute(
            `UPDATE content_generation_jobs SET status = 'completed', result_post_id = ${post.id}${tokenCols}, updated_at = now() WHERE id = ${job.id}`
        );

        // Admin test jobs do not notify the consumer
        if (!isAdminTest) {
            const [asst] = await db.select({ name: aiAssistants.name }).from(aiAssistants).where(eq(aiAssistants.id, job.assistant_id)).limit(1);
            const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1);
            await db.insert(notifications).values({
                userId: job.user_id,
                type: 'post_draft_ready',
                title: `${asst?.name ?? 'Your assistant'}: ${platformLabel} post draft ready`,
                message: job.trigger_type === 'on_demand'
                    ? 'Your on-demand post draft is ready to review.'
                    : `Your ${platformLabel} post draft is ready to review.`,
                metadata: { jobId: job.job_id, postId: post.id },
            });
        }

    } catch (err) {
        const attempt = job.attempt + 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[process-content-jobs] job ${job.job_id} attempt ${attempt} failed:`, errorMessage);

        if (attempt >= job.max_attempts) {
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
            const backoffSecs = BACKOFF_SECS[attempt - 1] ?? 90;
            const nextRetryAt = new Date(Date.now() + backoffSecs * 1000).toISOString();
            await db.execute(
                `UPDATE content_generation_jobs SET status = 'queued', next_retry_at = '${nextRetryAt}', error_message = '${errorMessage.replace(/'/g, "''")}', updated_at = now() WHERE id = ${job.id}`
            );
        }
    }
}
