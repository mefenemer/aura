import { Handler } from '@netlify/functions';
import { eq, sql } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    // Assistants are org-owned & member-shared — list everything in the active organisation.
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    try {
        // RLS-enforced: tenant-data queries run under withTenant (app_user + app.current_org).
        const assistants = await withTenant(orgId, (tx) => tx.select({
            id: aiAssistants.id,
            name: aiAssistants.name,
            role: aiAssistants.aiAssistantJobRole,
            // roleKey drives the connection-relevance map (connection-map.js).
            // Stored in configuration.type at creation (onboarding.ts).
            roleKey: sql<string | null>`(${aiAssistants.configuration} ->> 'type')`,
            status: aiAssistants.provisioningStatus,
            isActive: aiAssistants.isActive
        }).from(aiAssistants).where(eq(aiAssistants.organisationId, orgId)));

        return { statusCode: 200, body: JSON.stringify({ assistants }) };
    } catch (e) {
        console.error("Fetch Assistants Error:", e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Database error' }) };
    }
};