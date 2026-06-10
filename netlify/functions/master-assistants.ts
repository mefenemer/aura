// master-assistants.ts
// GET    — public endpoint, no auth required
//          Returns the full master assistant catalog with waitlist counts.
//          Logged-in callers also receive their own waitlist entries (for button state).
//
// PATCH  ?id=N — admin/internal: update a master assistant's fields.
//          When comingSoon transitions true→false, fans out in-app "new_role_availability"
//          notifications to every user who has notifyAvailability=true.
//
// GET query params:
//   ?category=Marketing+%26+Sales   (optional filter)
//   ?q=keyword                       (optional search)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, ilike, or } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { masterAssistants, waitlist, userProfiles, notifications } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

// ── PATCH: update master assistant (admin) ────────────────────────────────────
async function handlePatch(event: any): Promise<any> {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // Require auth for writes
    const cookieHeader = event.headers.cookie || '';
    const cookieMatch = cookieHeader.match(/aura_session=([^;]+)/);
    if (!cookieMatch) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let adminId: number;
    try {
        adminId = (jwt.verify(cookieMatch[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const id = parseInt(event.queryStringParameters?.id || '');
    if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id is required.' }) };

    let body: Record<string, any> = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const db = getDb();

    // Fetch current record
    const [existing] = await db
        .select()
        .from(masterAssistants)
        .where(eq(masterAssistants.id, id))
        .limit(1);
    if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'Master assistant not found.' }) };

    // Build update payload (only allow safe fields)
    const allowedFields = ['name', 'description', 'category', 'iconKey', 'iconColor', 'comingSoon', 'isActive'];
    const updates: Record<string, any> = {};
    for (const f of allowedFields) {
        if (body[f] !== undefined) updates[f] = body[f];
    }

    if (Object.keys(updates).length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No valid fields to update.' }) };
    }

    const [updated] = await db
        .update(masterAssistants)
        .set(updates)
        .where(eq(masterAssistants.id, id))
        .returning();

    // ── New role launch notification fan-out ──────────────────────────────────
    // Trigger: comingSoon was true and is now being set to false.
    const launchingNow = existing.comingSoon === true && updates.comingSoon === false;
    let notifiedCount = 0;

    if (launchingNow) {
        try {
            // Find all user profiles with notifyAvailability=true
            const profiles = await db
                .select({ userId: userProfiles.userId })
                .from(userProfiles)
                .where(eq(userProfiles.notifyAvailability, true));

            if (profiles.length > 0) {
                const notifRows = profiles.map(p => ({
                    userId: p.userId,
                    title: `New Role Available: ${updated.name}`,
                    message: `${updated.name} is now available to hire. Visit the Assistant Catalog to get started.`,
                    type: 'new_role_availability',
                    isRead: false,
                }));

                // Insert in batches of 100 to stay under DB limits
                for (let i = 0; i < notifRows.length; i += 100) {
                    await db.insert(notifications).values(notifRows.slice(i, i + 100));
                }
                notifiedCount = notifRows.length;
            }

            // Also mark waitlist entries for this assistant as notified
            await db
                .update(waitlist)
                .set({ notified: true })
                .where(eq(waitlist.masterAssistantId, id));
        } catch (fanOutErr) {
            // Non-blocking — update already applied; log and continue
            console.error('[master-assistants] Fan-out error (non-blocking):', fanOutErr);
        }
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant: updated, notifiedCount }),
    };
}

export const handler: Handler = async (event) => {
    if (event.httpMethod === 'PATCH') return handlePatch(event);
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
