// get-assistant-activity.ts
// GET ?id=<assistantId>
// Returns recent audit log entries for a specific assistant.
// Used by the assistant detail page "Recent Activity" feed.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, auditLogs } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // ── Auth ──────────────────────────────────────────────────────
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(cookie, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const assistantId = event.queryStringParameters?.id;
    if (!assistantId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'id parameter is required.' }) };
    }

    try {
        const db = getDb();

        // Verify the user exists (basic auth check)
        const [user] = await db.select({ id: users.id })
            .from(users).where(eq(users.id, userId));
        if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

        // Query audit logs for this assistant, most recent first, cap at 20
        const logs = await db
            .select({
                id: auditLogs.id,
                actionType: auditLogs.actionType,
                resourceType: auditLogs.resourceType,
                resourceId: auditLogs.resourceId,
                newState: auditLogs.newState,
                createdAt: auditLogs.createdAt,
            })
            .from(auditLogs)
            .where(
                and(
                    eq(auditLogs.resourceType, 'assistant'),
                    eq(auditLogs.resourceId, String(assistantId))
                )
            )
            .orderBy(desc(auditLogs.createdAt))
            .limit(20);

        // Map to a UI-friendly shape with a human-readable description
        const mapped = logs.map(log => ({
            id: log.id,
            actionType: log.actionType,
            description: _describe(log.actionType, log.newState as Record<string, any> | null),
            createdAt: log.createdAt,
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ logs: mapped }),
        };

    } catch (err: any) {
        const msg: string = err?.message || '';
        // Table not yet migrated — return empty gracefully
        if (msg.includes('relation') && msg.includes('does not exist')) {
            return { statusCode: 200, body: JSON.stringify({ logs: [] }) };
        }
        console.error('[get-assistant-activity]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load activity.' }) };
    }
};

// ── Helper: build a readable description from action type + new state ──
function _describe(actionType: string, newState: Record<string, any> | null): string {
    const state = newState || {};
    switch (actionType) {
        case 'CREATE':
            return `Assistant created${state.planName ? ` on the ${state.planName} plan` : ''}.`;
        case 'UPDATE':
            return _describeUpdate(state);
        case 'PUBLISH':
            return `Post published${state.platform ? ` to ${state.platform}` : ''}.`;
        case 'POST_SCHEDULED':
            return `Post scheduled${state.platform ? ` for ${state.platform}` : ''}${state.publishDate ? ` on ${new Date(state.publishDate).toLocaleDateString('en-GB')}` : ''}.`;
        case 'POST_APPROVED':
            return `Post approved${state.platform ? ` (${state.platform})` : ''}.`;
        case 'POST_CANCELLED':
            return `Scheduled post cancelled.`;
        case 'CONTEXT_UPDATED':
            return 'Assistant context and settings updated.';
        case 'PLATFORM_CONNECTED':
            return `Platform connected${state.platform ? `: ${state.platform}` : ''}.`;
        case 'PLATFORM_DISCONNECTED':
            return `Platform disconnected${state.platform ? `: ${state.platform}` : ''}.`;
        case 'INTEGRATION_ADDED':
            return `Integration added${state.name ? `: ${state.name}` : ''}.`;
        case 'AUTONOMOUS_ENABLED':
            return 'Autonomous posting fallback enabled.';
        case 'AUTONOMOUS_DISABLED':
            return 'Autonomous posting fallback disabled.';
        default:
            return actionType.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase()) + '.';
    }
}

function _describeUpdate(state: Record<string, any>): string {
    const changed = Object.keys(state).filter(k => k !== 'updatedAt' && k !== 'id');
    if (changed.length === 0) return 'Assistant settings updated.';
    if (changed.length === 1) {
        const key = changed[0].replace(/([A-Z])/g, ' $1').toLowerCase();
        return `Assistant ${key} updated.`;
    }
    return `Assistant updated (${changed.length} fields changed).`;
}
