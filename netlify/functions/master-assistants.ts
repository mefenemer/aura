// master-assistants.ts
// GET — public endpoint, no auth required
// Returns the full master assistant catalog with waitlist counts.
// Logged-in callers also receive their own waitlist entries (for button state).
//
// Query params:
//   ?category=Marketing+%26+Sales   (optional filter)
//   ?q=keyword                       (optional search)
//
// Response:
// {
//   assistants: [{
//     id, roleKey, name, description, category, iconKey, iconColor,
//     comingSoon, isActive,
//     waitlistCount: number,
//     onWaitlist: boolean,  // only true when caller is authenticated
//   }]
// }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, ilike, or } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { masterAssistants, waitlist } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    // Try to decode session (optional — guests still get catalog)
    let callerId: number | null = null;
    const cookieHeader = event.headers.cookie || '';
    const cookieMatch = cookieHeader.match(/aura_session=([^;]+)/);
    if (cookieMatch && jwtSecret) {
        try {
            const decoded = jwt.verify(cookieMatch[1], jwtSecret) as { userId: number };
            callerId = decoded.userId;
        } catch {
            // invalid session — treat as guest
        }
    }

    try {
        const db = getDb();

        // Fetch all active master assistants
        const rows = await db
            .select()
            .from(masterAssistants)
            .where(eq(masterAssistants.isActive, true))
            .orderBy(masterAssistants.id);

        // Fetch waitlist entries for these assistants
        const waitlistRows = await db
            .select()
            .from(waitlist);

        // Group waitlist counts per masterAssistantId
        const countMap: Record<number, number> = {};
        const userSet: Set<number> = new Set();

        for (const w of waitlistRows) {
            countMap[w.masterAssistantId] = (countMap[w.masterAssistantId] || 0) + 1;
            if (callerId && w.userId === callerId) {
                userSet.add(w.masterAssistantId);
            }
            // Also check by email is handled client-side for guests
        }

        // Apply search / category filters (server-side for clean API)
        const qParam = (event.queryStringParameters?.q || '').trim().toLowerCase();
        const catParam = (event.queryStringParameters?.category || '').trim();

        let filtered = rows;
        if (qParam) {
            filtered = filtered.filter(r =>
                r.name.toLowerCase().includes(qParam) ||
                (r.description || '').toLowerCase().includes(qParam) ||
                r.category.toLowerCase().includes(qParam)
            );
        }
        if (catParam && catParam !== 'All Roles') {
            filtered = filtered.filter(r => r.category === catParam);
        }

        const assistants = filtered.map(r => ({
            id: r.id,
            roleKey: r.roleKey,
            name: r.name,
            description: r.description,
            category: r.category,
            iconKey: r.iconKey,
            iconColor: r.iconColor,
            comingSoon: r.comingSoon,
            waitlistCount: countMap[r.id] || 0,
            onWaitlist: callerId ? userSet.has(r.id) : false,
        }));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assistants }),
        };
    } catch (err: any) {
        console.error('master-assistants error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load catalog.' }) };
    }
};
