import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, auditLogs } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'PUT') return { statusCode: 405, body: 'Method Not Allowed' };

    // 1. JWT Authentication Block
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    const token = match ? match[1] : null;

    if (!token) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
    }

    let currentUserId: number;
    try {
        const decoded = jwt.verify(token, jwtSecret) as { userId: number };
        currentUserId = decoded.userId;
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    // 2. Payload Extraction
    const { assistantId, newContext, newConfiguration, newName, appliedDefaults } = JSON.parse(event.body || '{}');

    if (!assistantId || !newContext) return { statusCode: 400, body: JSON.stringify({ error: 'Missing parameters.' }) };

    const db = getDb();

    try {
        await db.transaction(async (tx) => {
            // Fetch Previous State
            const [existingAssistant] = await tx.select()
                .from(aiAssistants)
                .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.userId, currentUserId)))
                .limit(1);

            if (!existingAssistant) throw new Error("Assistant not found.");

            // Perform the Update
            const updatePayload: any = { onboardingContext: newContext, updatedAt: new Date() };
            if (newConfiguration) updatePayload.configuration = newConfiguration;
            if (newName) updatePayload.name = newName;
            if (appliedDefaults !== undefined) {
                // Merge appliedDefaults into existing configuration rather than overwrite
                const existingConfig = existingAssistant.configuration as any || {};
                updatePayload.configuration = {
                    ...existingConfig,
                    ...(newConfiguration || {}),
                    appliedDefaults: {
                        ...(existingConfig.appliedDefaults || {}),
                        ...appliedDefaults,
                    },
                };
            }
            await tx.update(aiAssistants)
                .set(updatePayload)
                .where(eq(aiAssistants.id, assistantId));

            // SCENARIO 5: Create Immutable Audit Log
            await tx.insert(auditLogs).values({
                userId: currentUserId,
                actionType: 'UPDATE_CONTEXT',
                resourceType: 'aiAssistants',
                resourceId: assistantId.toString(),
                previousState: existingAssistant.onboardingContext,
                newState: newContext,
                ipAddress: event.headers['x-nf-client-connection-ip'] || 'unknown',
            });
        });

        return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } catch (error) {
        console.error('Update Context Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update context.' }) };
    }
};