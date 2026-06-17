// netlify/functions/get-social-drafts.ts
// US-SMM-3.4.1: Returns scheduled_posts with status='pending_approval' for the authenticated org.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, aiAssistants, userOrganisations } from '../../db/schema';

const JWT_SECRET = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const cookie = event.headers.cookie || '';
        const token = cookie.match(/aura_session=([^;]+)/)?.[1];
        if (!token || !JWT_SECRET) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
        const session = jwt.verify(token, JWT_SECRET) as { userId: number };

        const db = getDb();

        // JWT only contains userId — resolve the org from userOrganisations
        const [membership] = await db
            .select({ organisationId: userOrganisations.organisationId })
            .from(userOrganisations)
            .where(eq(userOrganisations.userId, session.userId))
            .limit(1);
        if (!membership) return { statusCode: 403, body: JSON.stringify({ error: 'No organisation found.' }) };
        const organisationId = membership.organisationId;

        const statusFilter = event.queryStringParameters?.status || 'pending_approval';

        const drafts = await db
            .select({
                id: scheduledPosts.id,
                platform: scheduledPosts.platform,
                caption: scheduledPosts.caption,
                hashtags: scheduledPosts.hashtags,
                suggestedMediaDescription: scheduledPosts.suggestedMediaDescription,
                conflictNotice: scheduledPosts.conflictNotice,
                status: scheduledPosts.status,
                triggerType: scheduledPosts.triggerType,
                publishDate: scheduledPosts.publishDate,
                generatedAt: scheduledPosts.generatedAt,
                assistantId: scheduledPosts.assistantId,
                jobId: scheduledPosts.jobId,
                rejectionReason: scheduledPosts.rejectionReason,
                assistantName: aiAssistants.name,
            })
            .from(scheduledPosts)
            .leftJoin(aiAssistants, eq(aiAssistants.id, scheduledPosts.assistantId))
            .where(and(
                eq(scheduledPosts.organisationId, organisationId),
                eq(scheduledPosts.status, statusFilter),
            ))
            .orderBy(desc(scheduledPosts.generatedAt))
            .limit(50);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ drafts }),
        };
    } catch (err) {
        console.error('[get-social-drafts]', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal error.' }) };
    }
};
