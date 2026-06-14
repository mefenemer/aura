// netlify/functions/generate-post.ts
// US-SMM-3.1.1: Accept a POST from the workspace, insert a generation job, return <500ms.
// A separate scheduled function (process-content-jobs) drains the queue each minute.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import { aiBlueprints, contentGenerationJobs, notifications, users } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const cookieHeader = event.headers.cookie || '';
    const sessionToken = cookieHeader.match(/aura_session=([^;]+)/)?.[1];
    if (!sessionToken || !jwtSecret) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    let organisationId: number;
    try {
        const payload = jwt.verify(sessionToken, jwtSecret) as { userId: number; organisationId: number };
        userId = payload.userId;
        organisationId = payload.organisationId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    let body: { blueprintId?: number; assistantId?: number };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const { blueprintId, assistantId } = body;
    if (!blueprintId || !assistantId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'blueprintId and assistantId are required.' }) };
    }

    const db = getDb();

    // Validate blueprint belongs to this org and is complete with no blocking gaps
    const [bp] = await db
        .select({ id: aiBlueprints.id, completenessPercent: aiBlueprints.completenessPercent, missingFields: aiBlueprints.missingFields })
        .from(aiBlueprints)
        .where(and(eq(aiBlueprints.id, blueprintId), eq(aiBlueprints.organisationId, organisationId)))
        .limit(1);

    if (!bp) return { statusCode: 404, body: JSON.stringify({ error: 'Blueprint not found.' }) };

    const missingFields = (bp.missingFields as Array<{ severity: string }>) || [];
    const blockingGaps = missingFields.filter(f => f.severity === 'blocking');
    if (blockingGaps.length > 0) {
        return { statusCode: 422, body: JSON.stringify({ error: 'Blueprint has blocking gaps. Resolve them before generating.' }) };
    }
    if (bp.completenessPercent < 100) {
        return { statusCode: 422, body: JSON.stringify({ error: 'Blueprint completeness must be 100% before generating.' }) };
    }

    const jobId = randomUUID();

    await db.insert(contentGenerationJobs).values({
        jobId,
        blueprintId,
        assistantId,
        organisationId,
        userId,
        status: 'queued',
        attempt: 0,
        maxAttempts: 3,
    });

    // In-app status notification
    await db.insert(notifications).values({
        userId,
        type: 'post_generation_queued',
        title: 'Generating your Instagram post…',
        message: 'Your post is being generated. This usually takes 30–60 seconds.',
        metadata: { jobId },
    });

    return {
        statusCode: 202,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, status: 'queued', estimatedReadyIn: '30–60 seconds' }),
    };
};
