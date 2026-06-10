// manage-assistant.ts
// PATCH  ?id=N  { action: "pause" | "resume" }  → toggle isActive
// DELETE ?id=N                                   → soft-delete (isActive=false, status=cancelled)
//
// Edit is handled client-side: redirect to onboarding with ?edit=assistantId
// so the user can modify their blueprint/setup answers.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try { return (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
}

export const handler: Handler = async (event) => {
    const userId = getAuth(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const qs = event.queryStringParameters || {};
    const id = parseInt(qs.id || '');
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

    const db = getDb();

    // Ownership check helper
    const findAssistant = async () => {
        const [row] = await db
            .select()
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, id), eq(aiAssistants.userId, userId)));
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
