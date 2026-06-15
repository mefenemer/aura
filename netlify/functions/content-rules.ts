// netlify/functions/content-rules.ts
// US-SMM-2.3.1: Content Rules Library — CRUD for per-assistant overarching content rules.
// Rules are injected into the generation prompt for all future drafts by the assistant.
//
// GET  ?assistantId=N[&platform=X]  — list rules (active + inactive)
// POST { assistantId, ruleText, platform?, note? }  — create rule manually
// PATCH { id, ruleText?, platform?, note?, isActive? }  — edit or toggle
// DELETE ?id=N  — hard delete

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq, isNull, or } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentRules, aiAssistants, scheduledPosts } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

function auth(event: any): { userId: number; orgId?: number } | null {
    try {
        const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
        if (!match) return null;
        const decoded = jwt.verify(match[1], jwtSecret!) as { userId: number; organisationId?: number };
        return { userId: decoded.userId, orgId: decoded.organisationId };
    } catch {
        return null;
    }
}

export const handler: Handler = async (event) => {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const user = auth(event);
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    const db = getDb();
    const method = event.httpMethod;
    const params = event.queryStringParameters || {};

    // ── GET — list rules for an assistant ────────────────────────────────────
    if (method === 'GET') {
        const assistantId = params.assistantId ? Number(params.assistantId) : NaN;
        if (isNaN(assistantId)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
        }

        // Verify the caller owns this assistant (via org)
        const [assistant] = await db.select({ orgId: aiAssistants.organisationId })
            .from(aiAssistants)
            .where(eq(aiAssistants.id, assistantId))
            .limit(1);
        if (!assistant || (user.orgId && assistant.orgId !== user.orgId)) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
        }

        const rows = await db.select().from(contentRules)
            .where(and(
                eq(contentRules.assistantId, assistantId),
                params.platform
                    ? or(isNull(contentRules.platform), eq(contentRules.platform, params.platform))
                    : undefined,
            ))
            .orderBy(contentRules.createdAt);

        // Enrich rejection_feedback rules with originPost caption snippet
        const enriched = await Promise.all(rows.map(async (rule) => {
            if (rule.origin !== 'rejection_feedback' || !rule.originPostId) return rule;
            const [originPost] = await db
                .select({ id: scheduledPosts.id, caption: scheduledPosts.caption, platform: scheduledPosts.platform })
                .from(scheduledPosts)
                .where(eq(scheduledPosts.id, rule.originPostId))
                .limit(1);
            return { ...rule, originPost: originPost ?? null };
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rules: enriched }),
        };
    }

    // ── POST — create rule manually ───────────────────────────────────────────
    if (method === 'POST') {
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
        }

        const { assistantId, ruleText, platform, note } = body;
        if (!assistantId || !ruleText?.trim()) {
            return { statusCode: 400, body: JSON.stringify({ error: 'assistantId and ruleText are required.' }) };
        }
        if (ruleText.trim().length > 300) {
            return { statusCode: 400, body: JSON.stringify({ error: 'ruleText must be 300 characters or fewer.' }) };
        }

        // Verify ownership
        const [assistant] = await db.select({ orgId: aiAssistants.organisationId })
            .from(aiAssistants)
            .where(eq(aiAssistants.id, Number(assistantId)))
            .limit(1);
        if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
        if (!user.orgId) return { statusCode: 403, body: JSON.stringify({ error: 'No organisation context.' }) };

        const [rule] = await db.insert(contentRules).values({
            assistantId:     Number(assistantId),
            workspaceId:     user.orgId,
            ruleText:        ruleText.trim(),
            platform:        platform || null,
            note:            note?.trim() || null,
            createdByUserId: user.userId,
            isActive:        true,
            origin:          'manual',
        }).returning();

        return {
            statusCode: 201,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rule }),
        };
    }

    // ── PATCH — edit rule text, scope, note, or toggle isActive ──────────────
    if (method === 'PATCH') {
        let body: any = {};
        try { body = JSON.parse(event.body || '{}'); } catch {
            return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
        }

        const { id, ruleText, platform, note, isActive } = body;
        if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

        const [existing] = await db.select().from(contentRules)
            .where(eq(contentRules.id, Number(id)))
            .limit(1);
        if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Rule not found.' }) };
        if (user.orgId && existing.workspaceId !== user.orgId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Access denied.' }) };
        }

        if (ruleText !== undefined && ruleText.trim().length > 300) {
            return { statusCode: 400, body: JSON.stringify({ error: 'ruleText must be 300 characters or fewer.' }) };
        }

        const updates: Record<string, any> = { updatedAt: new Date(), updatedBy: user.userId };
        if (ruleText !== undefined) {
            updates.previousText = existing.ruleText;
            updates.ruleText = ruleText.trim();
        }
        if (platform !== undefined) updates.platform = platform || null;
        if (note !== undefined) updates.note = note?.trim() || null;
        if (isActive !== undefined) updates.isActive = Boolean(isActive);

        const [updated] = await db.update(contentRules)
            .set(updates)
            .where(eq(contentRules.id, Number(id)))
            .returning();

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rule: updated }),
        };
    }

    // ── DELETE — hard delete ──────────────────────────────────────────────────
    if (method === 'DELETE') {
        const id = params.id ? Number(params.id) : NaN;
        if (isNaN(id)) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

        const [existing] = await db.select({ workspaceId: contentRules.workspaceId })
            .from(contentRules)
            .where(eq(contentRules.id, id))
            .limit(1);
        if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Rule not found.' }) };
        if (user.orgId && existing.workspaceId !== user.orgId) {
            return { statusCode: 403, body: JSON.stringify({ error: 'Access denied.' }) };
        }

        await db.delete(contentRules).where(eq(contentRules.id, id));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deleted: true, id }),
        };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
};
