import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { leads } from '../../db/schema';

export const handler: Handler = async (event) => {
    // ONLY accept POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const rawEmail = body.email || '';
        const role = body.role || '';
        // SC5 enterprise extra fields (optional)
        const name             = (body.name      || '').trim();
        const company          = (body.company   || '').trim();
        const teamSize         = (body.teamSize   || '').trim();
        const useCase          = (body.useCase    || '').trim();
        const opportunityReasonOverride = (body.opportunityReason || '').trim();

        const email = rawEmail.trim().toLowerCase();

        // Scenario 3: Backend validation fallback
        if (!email || !email.includes('@') || !role) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Valid email and role are required.' }) };
        }

        const db = getDb();

        // Scenario 2: Dynamic field mapping
        const opportunityReason = opportunityReasonOverride || `Interest in the ${role} Role`;
        const actionText = role === 'Enterprise'
            ? `Enterprise discovery call requested — ${company || 'unknown company'}, ${teamSize || 'unknown size'}: ${useCase.slice(0, 120) || 'no use case provided'}`
            : 'notify user of AI Assistant readiness';

        // Scenarios 1, 4, & 5: Insert or quietly update if it's a duplicate
        await db.insert(leads)
            .values({
                email,
                opportunityReason,
                action: actionText,
            })
            .onConflictDoUpdate({
                target: [leads.email, leads.opportunityReason],
                set: { updatedAt: new Date() } // Gracefully handles duplicates
            });

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, message: 'Lead captured successfully.' })
        };
    } catch (error) {
        console.error('Lead Capture Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An internal error occurred while saving your interest.' })
        };
    }
};