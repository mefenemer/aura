// manage-assistant.ts
// PATCH  ?id=N  { action: "pause" | "resume" }  → toggle isActive
// DELETE ?id=N                                   → soft-delete (isActive=false, status=cancelled)
//
// Edit is handled client-side: redirect to onboarding with ?edit=assistantId
// so the user can modify their blueprint/setup answers.

import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

export const handler: Handler = async (event) => {
    const db = getDb();
    // Managing a shared assistant (pause/resume/delete) is an owner/admin action within the org.
    const ctx = await requireTenant(event, db, { roles: ['owner', 'admin'] });
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    const qs = event.queryStringParameters || {};
    const id = parseInt(qs.id || '');
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

    // Resolve the assistant within the active organisation (member-shared ownership).
    const findAssistant = async () => {
        const [row] = await db
            .select()
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, id), eq(aiAssistants.organisationId, orgId)));
        return row ?? null;
    };

    try {
        // ── PATCH: pause / resume ─────────────────────────────────
        if (event.httpMethod === 'PATCH') {
            const body = JSON.parse(event.body || '{}');
            const action: string = body.action || '';

            if (!['pause', 'resume'].includes(action)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'action must be "pause" or "resume".' }) };
            }

            const existing = await findAssistant();
            if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

            // US-GOV-3.1.1: Block resume if disclosure is missing (EU AI Act Art. 52)
            if (action === 'resume' && !existing.disclosureText?.trim()) {
                return {
                    statusCode: 422,
                    body: JSON.stringify({
                        error: 'AI disclosure text is required before this assistant can be activated (EU AI Act Art. 52).',
                        code: 'DISCLOSURE_MISSING',
                    }),
                };
            }

            const [updated] = await db
                .update(aiAssistants)
                .set({ isActive: action === 'resume', updatedAt: new Date() })
                .where(eq(aiAssistants.id, id))
                .returning();

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assistant: updated }),
            };
        }

        // ── DELETE: soft-delete ───────────────────────────────────
        if (event.httpMethod === 'DELETE') {
            const existing = await findAssistant();
            if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

            const [deleted] = await db
                .update(aiAssistants)
                .set({
                    isActive: false,
                    provisioningStatus: 'cancelled',
                    updatedAt: new Date(),
                })
                .where(eq(aiAssistants.id, id))
                .returning();

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, assistant: deleted }),
            };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (err: any) {
        console.error('[manage-assistant] Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};
