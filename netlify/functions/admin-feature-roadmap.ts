// netlify/functions/admin-feature-roadmap.ts
// Admin Feature Roadmap board API (Testing section).
//
// GET    /admin-feature-roadmap                  → all items, ordered by sort_order (board order)
// POST   /admin-feature-roadmap { title, description?, priority? }
//                                                → create a manual item at the top of the board
// POST   /admin-feature-roadmap?action=reorder { order: number[] }
//                                                → rewrite sort_order to match the given id order
// PATCH  /admin-feature-roadmap?id=N { title?, description?, priority?, status? }
//                                                → update an item
// DELETE /admin-feature-roadmap?id=N             → remove an item
//
// Admin-only (users.role IN admin roles). Items come from promoted issue reports
// (source='issue') or are added directly here (source='manual'). See db/feature-roadmap.sql.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, asc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { featureRoadmap, issueReports, users } from '../../db/schema';
import { isAdminRole } from '../../src/utils/rbac';
import {
    isRoadmapPriority,
    isRoadmapStatus,
    nextTopSortOrder,
    ROADMAP_PRIORITY_LABEL,
    ROADMAP_STATUS_LABEL,
    type RoadmapPriority,
    type RoadmapStatus,
} from '../../src/utils/feature-roadmap';

const jwtSecret = process.env.JWT_SECRET;

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

async function requireAdmin(event: any): Promise<{ id: number; role: string } | null> {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
    const db = getDb();
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (!row || !isAdminRole(row.role)) return null;
    return { id: userId, role: row.role };
}

export const handler: Handler = async (event) => {
    const admin = await requireAdmin(event);
    if (!admin) return json(403, { error: 'Access denied. Admin role required.' });

    const db = getDb();
    const qs = event.queryStringParameters || {};
    const id = qs.id ? Number(qs.id) : null;
    const action = qs.action || '';

    // ── POST ?action=reorder: persist a new board order ──────────────────────────
    if (event.httpMethod === 'POST' && action === 'reorder') {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        const order = Array.isArray(body.order) ? body.order.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n)) : null;
        if (!order || !order.length) return json(400, { error: 'Provide an "order" array of item ids.' });

        // sort_order = index in the supplied order (lower sorts higher).
        for (let i = 0; i < order.length; i++) {
            await db.update(featureRoadmap)
                .set({ sortOrder: i, updatedAt: new Date() })
                .where(eq(featureRoadmap.id, order[i]));
        }
        return json(200, { ok: true });
    }

    // ── POST: create a manual item at the top of the board ───────────────────────
    if (event.httpMethod === 'POST') {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) return json(400, { error: 'Title is required.' });
        const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null;
        const priority: RoadmapPriority = isRoadmapPriority(body.priority) ? body.priority : 'medium';

        const sortOrder = await nextTopSortOrder(db);
        const [inserted] = await db.insert(featureRoadmap).values({
            title: title.slice(0, 200),
            description,
            priority,
            status: 'planned',
            sortOrder,
            source: 'manual',
            createdBy: admin.id,
        }).returning({ id: featureRoadmap.id });
        return json(200, { ok: true, id: inserted.id });
    }

    // ── PATCH ?id=N: update an item ──────────────────────────────────────────────
    if (event.httpMethod === 'PATCH' && id) {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const set: Record<string, unknown> = { updatedAt: new Date() };
        if (typeof body.title === 'string') {
            const t = body.title.trim();
            if (!t) return json(400, { error: 'Title cannot be empty.' });
            set.title = t.slice(0, 200);
        }
        if (typeof body.description === 'string') set.description = body.description.trim() || null;
        if (body.priority !== undefined) {
            if (!isRoadmapPriority(body.priority)) return json(400, { error: 'Invalid priority.' });
            set.priority = body.priority as RoadmapPriority;
        }
        if (body.status !== undefined) {
            if (!isRoadmapStatus(body.status)) return json(400, { error: 'Invalid status.' });
            set.status = body.status as RoadmapStatus;
        }
        if (Object.keys(set).length === 1) return json(400, { error: 'Nothing to update.' });

        const [updated] = await db.update(featureRoadmap)
            .set(set)
            .where(eq(featureRoadmap.id, id))
            .returning({ id: featureRoadmap.id });
        if (!updated) return json(404, { error: 'Item not found.' });
        return json(200, { ok: true });
    }

    // ── DELETE ?id=N ─────────────────────────────────────────────────────────────
    if (event.httpMethod === 'DELETE' && id) {
        const [deleted] = await db.delete(featureRoadmap)
            .where(eq(featureRoadmap.id, id))
            .returning({ id: featureRoadmap.id });
        if (!deleted) return json(404, { error: 'Item not found.' });
        return json(200, { ok: true });
    }

    // ── GET: list the board ──────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const rows = await db
            .select({
                id: featureRoadmap.id,
                title: featureRoadmap.title,
                description: featureRoadmap.description,
                priority: featureRoadmap.priority,
                status: featureRoadmap.status,
                sortOrder: featureRoadmap.sortOrder,
                source: featureRoadmap.source,
                issueId: featureRoadmap.issueId,
                createdAt: featureRoadmap.createdAt,
                updatedAt: featureRoadmap.updatedAt,
                reporterEmail: users.email,
            })
            .from(featureRoadmap)
            .leftJoin(issueReports, eq(issueReports.id, featureRoadmap.issueId))
            .leftJoin(users, eq(users.id, issueReports.userId))
            .orderBy(asc(featureRoadmap.sortOrder), asc(featureRoadmap.id));

        return json(200, {
            items: rows.map((r) => ({
                ...r,
                priorityLabel: ROADMAP_PRIORITY_LABEL[r.priority as RoadmapPriority] || r.priority,
                statusLabel: ROADMAP_STATUS_LABEL[r.status as RoadmapStatus] || r.status,
            })),
        });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};
