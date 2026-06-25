// netlify/functions/suggest-post-idea.ts
// "Create Post" → Suggest an idea mode. The user submits a short post idea only; it is NOT drafted
// now. It's stored in post_idea_suggestions (status='pending') and consumed once, FIFO, by the next
// scheduled/conversion generation job that carries no context_prompt (see process-content-jobs.ts).

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, postIdeaSuggestions } from '../../db/schema';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { requireTenant } from '../../src/utils/tenant';

const VALID_PLATFORMS = ['instagram', 'facebook', 'linkedin', 'x'];

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    let body: { assistantId?: number; idea?: string; platform?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const { assistantId } = body;
    const idea = (body.idea || '').trim();
    const platform = body.platform && VALID_PLATFORMS.includes(body.platform) ? body.platform : null;

    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
    if (!idea) return { statusCode: 400, body: JSON.stringify({ error: 'Please describe your post idea.' }) };
    if (idea.length > 500) return { statusCode: 400, body: JSON.stringify({ error: 'Your idea must be 500 characters or fewer.' }) };

    // Hard-block severe-violation prompts (mirrors generate-post.ts).
    const modBlock = await enforcePromptModeration({ text: idea, userId, organisationId, source: 'suggest-post-idea' });
    if (modBlock) return modBlock;

    // Verify the assistant belongs to this org.
    const [asst] = await db
        .select({ id: aiAssistants.id })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId)))
        .limit(1);
    if (!asst) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

    await db.insert(postIdeaSuggestions).values({
        organisationId,
        assistantId,
        userId,
        idea,
        platform,
        status: 'pending',
    });

    return {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true }),
    };
};
