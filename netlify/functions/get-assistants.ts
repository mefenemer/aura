import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
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
        const assistants = await db.select({
            id: aiAssistants.id,
            name: aiAssistants.name,
            role: aiAssistants.aiAssistantJobRole,
            status: aiAssistants.provisioningStatus,
            isActive: aiAssistants.isActive
        }).from(aiAssistants).where(eq(aiAssistants.organisationId, orgId));

        return { statusCode: 200, body: JSON.stringify({ assistants }) };
    } catch (e) {
        console.error("Fetch Assistants Error:", e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Database error' }) };
    }
};