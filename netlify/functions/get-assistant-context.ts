import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, dpaAcceptances, masterAssistants } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const assistantId = event.queryStringParameters?.id;
    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'Assistant ID required.' }) };

    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    const token = match ? match[1] : null;

    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let currentUserId: number;
    try {
        currentUserId = (jwt.verify(token, jwtSecret) as { userId: number }).userId;
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    const [row] = await db.select({
        id: aiAssistants.id,
        name: aiAssistants.name,
        role: aiAssistants.aiAssistantJobRole,
        status: aiAssistants.provisioningStatus,
        isActive: aiAssistants.isActive,
        onboardingContext: aiAssistants.onboardingContext,
        configuration: aiAssistants.configuration,
        masterAssistantId: aiAssistants.masterAssistantId,
        disclosureText: aiAssistants.disclosureText,
        organisationId: aiAssistants.organisationId,
        lifecycleState: masterAssistants.lifecycleState,
        replacementAssistantId: masterAssistants.replacementAssistantId,
        replacementName: masterAssistants.name,
    }).from(aiAssistants)
        .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.id, parseInt(assistantId)), eq(aiAssistants.userId, currentUserId)))
        .limit(1);

    if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

    // US-GDPR-1.1.1: Surface DPA status so UI can prompt acceptance
    let dpaAccepted = true;
    if (row.organisationId) {
        const [dpa] = await db
            .select({ id: dpaAcceptances.id })
            .from(dpaAcceptances)
            .where(eq(dpaAcceptances.organisationId, row.organisationId))
            .limit(1);
        dpaAccepted = !!dpa;
    }

    return { statusCode: 200, body: JSON.stringify({
            context: row.onboardingContext,
            configuration: row.configuration,
            name: row.name,
            role: row.role || 'Digital Assistant',
            status: row.status || 'pending',
            isActive: row.isActive,
            disclosureText: row.disclosureText ?? null,
            dpaAccepted,
            lifecycleState: row.lifecycleState ?? 'live',
            replacementAssistantId: row.replacementAssistantId ?? null,
        }) };
};