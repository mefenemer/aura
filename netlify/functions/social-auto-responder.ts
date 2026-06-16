// netlify/functions/social-auto-responder.ts
// US-SMM-4.2.1: LLM-generated auto-responder messages pushed to Meta Graph API.
// POST { assistantId }  — generates Messenger greeting, Messenger auto-reply, Instagram DM auto-reply.
// Stores draft in aiAssistants.configuration.autoResponderDraft.

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, systemConnections, organisations, notifications, userOrganisations } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';

const jwtSecret  = process.env.JWT_SECRET!;
const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL      = 'claude-haiku-4-5-20251001';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const cookieHeader = event.headers.cookie || '';
    const sessionToken = cookieHeader.match(/aura_session=([^;]+)/)?.[1];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

    let userId: number;
    let organisationId: number;
    try {
        const p = jwt.verify(sessionToken, jwtSecret) as { userId: number; organisationId: number };
        userId = p.userId;
        organisationId = p.organisationId;
    } catch { return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session' }) }; }

    const body = JSON.parse(event.body || '{}');
    const { assistantId } = body as { assistantId?: number };

    const db = getDb();

    // Load assistant blueprint / onboarding context
    const [assistant] = await db.select({ id: aiAssistants.id, name: aiAssistants.name, onboardingContext: aiAssistants.onboardingContext, systemPrompt: aiAssistants.systemPrompt, configuration: aiAssistants.configuration })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.organisationId, organisationId), ...(assistantId ? [eq(aiAssistants.id, assistantId)] : []), eq(aiAssistants.isActive, true)))
        .limit(1);

    if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'No active assistant found' }) };

    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, organisationId)).limit(1);
    const businessName = org?.name ?? 'your business';
    const ctx = assistant.onboardingContext as Record<string, unknown> ?? {};
    const toneOfVoice = (ctx.tone_of_voice as string) ?? 'friendly and professional';
    const targetAudience = (ctx.target_audience as string) ?? 'customers';
    const contentPillars = Array.isArray(ctx.content_pillars) ? (ctx.content_pillars as string[]).join(', ') : (ctx.content_pillars as string) ?? '';

    // Include blueprint sections in the prompt (AC: full context)
    const blueprintContext = [
        assistant.systemPrompt ? `## System Prompt\n${assistant.systemPrompt}` : '',
        contentPillars ? `## Content Pillars\n${contentPillars}` : '',
        (ctx.strict_rules as string) ? `## Strict Rules\n${ctx.strict_rules}` : '',
        (ctx.brand_guidelines as string) ? `## Brand Guidelines\n${ctx.brand_guidelines}` : '',
    ].filter(Boolean).join('\n\n');

    const prompt = `You are a social media assistant for ${businessName}. Tone: ${toneOfVoice}. Target audience: ${targetAudience}.

${blueprintContext ? `## Assistant Blueprint Context\n${blueprintContext}\n\n` : ''}Generate three auto-responder messages that reflect the brand voice above. Return ONLY valid JSON with these exact keys:
{
  "messengerGreeting": "string, max 160 chars — the welcome message shown when someone opens Messenger for the first time",
  "messengerAutoReply": "string, max 500 chars — the auto-reply sent when someone messages the Facebook Page",
  "instagramDmAutoReply": "string, max 500 chars — the auto-reply sent when someone DMs on Instagram (stored as a draft — Instagram DM automation must be enabled separately in Meta Business Suite)"
}

Rules:
- Use the business name naturally
- Keep a warm, ${toneOfVoice} tone consistent with the blueprint
- Do not make promises you cannot keep
- Do not include placeholders like [NAME] or [DATE]
- Ensure the Messenger greeting is ≤160 characters exactly`;

    let draft: { messengerGreeting: string; messengerAutoReply: string; instagramDmAutoReply: string } | null = null;
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await anthropic.messages.create({
                model: MODEL,
                max_tokens: 512,
                messages: [{ role: 'user', content: prompt }],
            });
            const raw = (response.content[0] as { text: string }).text.trim();
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
            if (parsed?.messengerGreeting && parsed?.messengerAutoReply && parsed?.instagramDmAutoReply) {
                draft = parsed;
                break;
            }
            console.warn(`[social-auto-responder] Attempt ${attempt}: invalid LLM response format`);
        } catch (err) {
            console.warn(`[social-auto-responder] Attempt ${attempt} error:`, err);
            if (attempt === MAX_RETRIES) {
                return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate auto-responder messages after retries' }) };
            }
            // Exponential backoff: 1s, 2s, 4s
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
    }
    if (!draft) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate valid auto-responder messages' }) };
    }

    // Enforce char limits
    draft.messengerGreeting    = draft.messengerGreeting.slice(0, 160);
    draft.messengerAutoReply   = draft.messengerAutoReply.slice(0, 500);
    draft.instagramDmAutoReply = draft.instagramDmAutoReply.slice(0, 500);

    // Store draft in assistant configuration
    const existingConfig = (assistant.configuration as Record<string, unknown>) ?? {};
    await db.update(aiAssistants).set({
        configuration: { ...existingConfig, autoResponderDraft: draft, autoResponderDraftAt: new Date().toISOString() },
        updatedAt: new Date(),
    }).where(eq(aiAssistants.id, assistant.id));

    // Push to Meta Graph API
    const [conn] = await db.select({ vaultRefKey: systemConnections.vaultRefKey, metadata: systemConnections.metadata })
        .from(systemConnections)
        .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, 'instagram'), eq(systemConnections.isActive, true)))
        .limit(1);

    let metaPushStatus: 'ok' | 'skipped' | 'failed' = 'skipped';
    let metaPushError: string | undefined;

    if (conn?.vaultRefKey) {
        const secret = await getSecret(db, conn.vaultRefKey);
        const token = (secret as { token?: string } | null)?.token;
        const fbPageId = (conn.metadata as Record<string, unknown>)?.fbPageId as string | undefined;

        if (token && fbPageId) {
            try {
                // Push Messenger greeting via messenger_profile API (AC: correct endpoint)
                const greetingRes = await fetch(`https://graph.facebook.com/v19.0/${fbPageId}/messenger_profile`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ greeting: [{ locale: 'default', text: draft.messengerGreeting }], access_token: token }),
                });
                // Set Messenger away/auto-reply message via page messaging settings
                // Meta's documented endpoint for "Instant Reply" text: POST /{page-id}/messaging (page_response type)
                const awayRes = await fetch(`https://graph.facebook.com/v19.0/${fbPageId}/messaging`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messaging_type: 'page_response', message: { text: draft.messengerAutoReply }, access_token: token }),
                });
                // Instagram DM auto-reply: stored as draft only — Instagram DM automation is configured
                // via Meta Business Suite; there is no public Graph API endpoint to set it programmatically.
                const greetingOk = greetingRes.ok;
                const awayOk = awayRes.ok;
                metaPushStatus = greetingOk ? (awayOk ? 'ok' : 'partial') : 'failed';
            } catch (err) {
                metaPushStatus = 'failed';
                metaPushError = String(err);
                console.warn('[social-auto-responder] Meta push failed:', err);
            }
        }
    }

    // Notify user
    await db.insert(notifications).values({
        userId,
        type: 'auto_responder_generated',
        title: 'Auto-responder messages generated',
        message: `New auto-responder copy has been created for ${assistant.name}. ${metaPushStatus === 'ok' ? 'Messages pushed to Meta.' : 'Review and apply from the Connections page.'}`,
        metadata: { assistantId: assistant.id, metaPushStatus, draft },
    });

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, draft, metaPushStatus, ...(metaPushError ? { metaPushError } : {}) }),
    };
};
