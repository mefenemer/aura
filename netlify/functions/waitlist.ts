// waitlist.ts
// POST — join the waitlist for a coming-soon assistant role.
//
// Body (JSON):
//   { masterAssistantId: number, email?: string }
//
// Logged-in users: email is taken from their account (no need to send it)
// Guest users: must supply email
//
// Response:
//   { success: true, alreadyOnList: boolean }
//   { error: string }  on failure

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { masterAssistants, waitlist, users } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: { masterAssistantId?: number; email?: string } = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { masterAssistantId, email: rawEmail } = body;
    if (!masterAssistantId || typeof masterAssistantId !== 'number') {
        return { statusCode: 400, body: JSON.stringify({ error: 'masterAssistantId is required.' }) };
    }

    // Resolve caller identity
    let callerId: number | null = null;
    let callerEmail: string | null = null;

    const cookieHeader = event.headers.cookie || '';
    const cookieMatch = cookieHeader.match(/aura_session=([^;]+)/);
    if (cookieMatch && jwtSecret) {
        try {
            const decoded = jwt.verify(cookieMatch[1], jwtSecret) as { userId: number; email: string };
            callerId = decoded.userId;
            callerEmail = decoded.email;
        } catch { /* guest */ }
    }

    // Guests must supply email
    const email = callerEmail || (rawEmail || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'A valid email address is required.' }) };
    }

    try {
        const db = getDb();

        // Verify the assistant exists and is coming-soon
        const [assistant] = await db
            .select({ id: masterAssistants.id, comingSoon: masterAssistants.comingSoon })
            .from(masterAssistants)
            .where(eq(masterAssistants.id, masterAssistantId))
            .limit(1);

        if (!assistant) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
        }

        // Check for existing entry by email + role (regardless of userId)
        const existing = await db
            .select({ id: waitlist.id })
            .from(waitlist)
            .where(
                and(
                    eq(waitlist.email, email),
                    eq(waitlist.masterAssistantId, masterAssistantId)
                )
            )
            .limit(1);

        if (existing.length > 0) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, alreadyOnList: true }),
            };
        }

        // Insert new waitlist entry
        await db.insert(waitlist).values({
            userId: callerId,
            email,
            masterAssistantId,
            source: callerId ? 'registered' : 'public',
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, alreadyOnList: false }),
        };
    } catch (err: any) {
        console.error('waitlist error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to join waitlist.' }) };
    }
};
