// netlify/functions/assistant-command.ts
// US-DASH-3 (AC3): the omnipresent command bar's brain. Takes a free-text command,
// interprets intent with an LLM, and returns a friendly reply plus a STRUCTURED action
// the client executes against existing endpoints (no new execution surface here):
//
//  POST { command: string }
//   → { type: 'navigate'|'delegate'|'answer', reply, view?, assistantId?, platform?, brief? }
//
// Interpretation only — the client performs navigation (loadView), delegation
// (generate-post), or simply shows the answer. Auth: aura_session + active org.

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

// The workspace views the bar is allowed to route to (mirrors workspace.html routes).
const VIEWS = ['dashboard', 'assistants', 'review-queue', 'calendar', 'my-content', 'catalog', 'billing', 'settings', 'notifications', 'help', 'referral'] as const;

// Light per-instance rate limit to keep the bar cheap (matches social-troubleshoot-chat style).
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;
const rate = new Map<number, { count: number; start: number }>();
function allow(userId: number): boolean {
    const now = Date.now();
    const e = rate.get(userId);
    if (!e || now - e.start > RATE_WINDOW_MS) { rate.set(userId, { count: 1, start: now }); return true; }
    if (e.count >= RATE_MAX) return false;
    e.count++; return true;
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    if (!allow(userId)) {
        return { statusCode: 429, body: JSON.stringify({ type: 'answer', reply: 'You are sending commands very quickly — give me a moment and try again.' }) };
    }

    let body: { command?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    const command = (body.command || '').trim();
    if (!command) return { statusCode: 400, body: JSON.stringify({ error: 'command is required' }) };
    if (command.length > 600) return { statusCode: 400, body: JSON.stringify({ type: 'answer', reply: 'That is a bit long for the command bar — try a shorter instruction.' }) };

    // Active assistants for routing/delegation context.
    const assistants = await db
        .select({ id: aiAssistants.id, name: aiAssistants.name, role: aiAssistants.aiAssistantJobRole })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.organisationId, orgId), inArray(aiAssistants.lifecycleStatus, ['working', 'ready_for_work', 'paused'])));

    const assistantList = assistants.length
        ? assistants.map(a => `  - id ${a.id}: "${a.name}" (${a.role || 'assistant'})`).join('\n')
        : '  (none active yet)';

    const system = `You are the command interpreter for "Be More Swan", a digital-assistant platform for small businesses.
The user typed a quick command into a Spotlight-style command bar. Decide the single best action and reply in JSON only.

Available workspace views (use exact keys): ${VIEWS.join(', ')}.
The user's active assistants:
${assistantList}

Return STRICT JSON (no markdown, no prose) with this shape:
{
  "type": "navigate" | "delegate" | "answer",
  "reply": "one short, warm first-person sentence confirming what you're doing",
  "view": "<one view key>",          // only for navigate
  "assistantId": <number|null>,       // only for delegate; pick the most relevant active assistant, else null
  "platform": "instagram|facebook|linkedin|x|null",  // only for delegate, if a social platform is named/implied
  "brief": "<concise brief of what to create>"        // only for delegate
}

Rules:
- "navigate" when the user wants to go somewhere or see something (e.g. "show my review queue", "open calendar", "what needs approval").
- "delegate" when the user wants the team to CREATE or DO something (e.g. "draft a LinkedIn post about our sale", "write an Instagram caption"). Choose the most relevant assistant id; if none fits, set assistantId null and still give a brief.
- "answer" for questions you can answer briefly, greetings, or anything that doesn't map to a view or a delegation.
- Keep "reply" under 18 words, friendly, first person ("On it — ...", "Opening ...", "Here's ...").
- Never invent assistant ids or view keys.`;

    try {
        const response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 300,
            system,
            messages: [{ role: 'user', content: command }],
        });

        const raw = (response.content[0] as { text: string }).text.trim();
        // Defensive parse: strip any accidental code fences.
        const jsonText = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        let parsed: any;
        try { parsed = JSON.parse(jsonText); } catch {
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'answer', reply: raw.slice(0, 240) || "Sorry, I didn't quite catch that — try rephrasing." }) };
        }

        // Validate / sanitise the action so the client can trust it.
        const type = ['navigate', 'delegate', 'answer'].includes(parsed.type) ? parsed.type : 'answer';
        const out: any = { type, reply: typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : 'Done.' };

        if (type === 'navigate') {
            out.view = (VIEWS as readonly string[]).includes(parsed.view) ? parsed.view : 'dashboard';
        } else if (type === 'delegate') {
            const validId = assistants.find(a => a.id === Number(parsed.assistantId));
            out.assistantId = validId ? validId.id : null;
            out.platform = ['instagram', 'facebook', 'linkedin', 'x'].includes((parsed.platform || '').toLowerCase()) ? parsed.platform.toLowerCase() : null;
            out.brief = typeof parsed.brief === 'string' ? parsed.brief.slice(0, 500) : command;
            // If we have no assistant to delegate to, soften to guidance.
            if (!out.assistantId) {
                out.type = 'answer';
                out.reply = assistants.length
                    ? `I couldn't tell which assistant should handle that — open Assistants and I'll help you pick.`
                    : `You don't have an active assistant for that yet — let's hire one from the catalog.`;
                out.suggestView = assistants.length ? 'assistants' : 'catalog';
            }
        }

        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
    } catch (err) {
        console.error('[assistant-command] LLM error:', err);
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'answer', reply: "I'm having trouble right now — please try again in a moment." }) };
    }
};
