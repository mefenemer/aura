// admin-api.ts  (US6, US8, US9)
// Secure admin-only REST API for the Admin Workspace.
// All endpoints require a valid session AND users.role IN ('admin','super_admin').
//
// GET  /admin-api?resource=dashboard          → KPIs summary
// GET  /admin-api?resource=users[&q=&page=]   → paginated user list
// GET  /admin-api?resource=user&id=N          → single user detail
// PATCH /admin-api?resource=user&id=N         → edit user (status, role, subscription)
// DELETE /admin-api?resource=user&id=N        → delete user account
// GET  /admin-api?resource=tickets[&status=&category=&page=] → support ticket list
// GET  /admin-api?resource=catalog            → master assistants list
// PATCH /admin-api?resource=catalog&id=N      → toggle comingSoon / isActive on master assistant
// GET  /admin-api?resource=analytics          → sign-up counts grouped by role (US9)
// GET  /admin-api?resource=model-config       → AI model config rows (US13)
// PATCH /admin-api?resource=model-config&id=N → update a model config slot (US13)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, ilike, desc, sql, and, or, count } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    users, userProfiles, plans, aiAssistants,
    supportTickets, masterAssistants, waitlist,
    leads, auditLogs, notifications, aiModelConfig,
} from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;
const PAGE_SIZE = 25;

// ── Auth helper — returns userId or null; enforces admin role ─────────────────
async function requireAdmin(event: any): Promise<number | null> {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; }
    catch { return null; }

    const db = getDb();
    const [row] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

    if (!row || !['admin', 'super_admin'].includes(row.role)) return null;
    return userId;
}

// ── Audit helper ──────────────────────────────────────────────────────────────
async function audit(db: any, adminId: number, action: string, resource: string, resourceId: string | number, newState?: any) {
    try {
        await db.insert(auditLogs).values({
            userId: adminId,
            actionType: action,
            resourceType: resource,
            resourceId: String(resourceId),
            newState: newState ?? null,
        });
    } catch { /* non-blocking */ }
}

export const handler: Handler = async (event) => {
    const adminId = await requireAdmin(event);
    if (!adminId) {
        return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Access denied. Admin role required.' }) };
    }

    const qs = event.queryStringParameters || {};
    const resource = qs.resource || '';
    const db = getDb();

    try {
        // ── GET: dashboard KPIs ───────────────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'dashboard') {
            const [totalUsers] = await db.select({ c: count() }).from(users);
            const [pendingUsers] = await db.select({ c: count() }).from(users).where(eq(users.status, 'pending_verification'));
            const [activeAssistants] = await db.select({ c: count() }).from(aiAssistants).where(and(eq(aiAssistants.isActive, true)));
            const [pausedAssistants] = await db.select({ c: count() }).from(aiAssistants).where(eq(aiAssistants.isActive, false));
            const [activePlans] = await db.select({ c: count() }).from(plans).where(eq(plans.status, 'active'));
            const [openTickets] = await db.select({ c: count() }).from(supportTickets).where(eq(supportTickets.status, 'open'));

            // Waitlist totals per coming-soon assistant
            const waitlistCounts = await db
                .select({ masterAssistantId: waitlist.masterAssistantId, c: count() })
                .from(waitlist)
                .groupBy(waitlist.masterAssistantId);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    totalUsers: totalUsers.c,
                    pendingUsers: pendingUsers.c,
                    activeUsers: Number(totalUsers.c) - Number(pendingUsers.c),
                    activeAssistants: activeAssistants.c,
                    pausedAssistants: pausedAssistants.c,
                    activePlans: activePlans.c,
                    openTickets: openTickets.c,
                    waitlistCounts,
                }),
            };
        }

        // ── GET: user list ────────────────────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'users') {
            const page = Math.max(0, parseInt(qs.page || '0'));
            const q = (qs.q || '').trim();

            const baseCondition = q
                ? or(ilike(users.email, `%${q}%`), ilike(users.firstName, `%${q}%`), ilike(users.lastName, `%${q}%`))
                : undefined;

            const rows = await db
                .select({
                    id: users.id,
                    firstName: users.firstName,
                    lastName: users.lastName,
                    email: users.email,
                    status: users.status,
                    role: users.role,
                    createdAt: users.createdAt,
                    planName: plans.planName,
                    planStatus: plans.status,
                })
                .from(users)
                .leftJoin(plans, and(eq(plans.userId, users.id), eq(plans.status, 'active')))
                .where(baseCondition)
                .orderBy(desc(users.createdAt))
                .limit(PAGE_SIZE)
                .offset(page * PAGE_SIZE);

            const [{ c: total }] = await db.select({ c: count() }).from(users).where(baseCondition);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ users: rows, total, page, pageSize: PAGE_SIZE }),
            };
        }

        // ── GET: single user detail ───────────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'user') {
            const uid = parseInt(qs.id || '');
            if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const [row] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
            if (!row) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

            const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, uid)).limit(1);
            const [plan] = await db.select().from(plans).where(and(eq(plans.userId, uid), eq(plans.status, 'active'))).limit(1);
            const assistantsList = await db.select({ id: aiAssistants.id, name: aiAssistants.name, isActive: aiAssistants.isActive, provisioningStatus: aiAssistants.provisioningStatus }).from(aiAssistants).where(eq(aiAssistants.userId, uid));

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: row, profile, plan, assistants: assistantsList }),
            };
        }

        // ── PATCH: update user ────────────────────────────────────────────────
        if (event.httpMethod === 'PATCH' && resource === 'user') {
            const uid = parseInt(qs.id || '');
            if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const body = JSON.parse(event.body || '{}');
            const allowed = ['status', 'role', 'firstName', 'lastName'];
            const updates: Record<string, any> = { updatedAt: new Date() };
            for (const f of allowed) {
                if (body[f] !== undefined) updates[f] = body[f];
            }

            const [updated] = await db.update(users).set(updates).where(eq(users.id, uid)).returning();
            await audit(db, adminId, 'UPDATE', 'users', uid, updates);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: updated }),
            };
        }

        // ── DELETE: remove user ───────────────────────────────────────────────
        if (event.httpMethod === 'DELETE' && resource === 'user') {
            const uid = parseInt(qs.id || '');
            if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };
            if (uid === adminId) return { statusCode: 400, body: JSON.stringify({ error: 'Cannot delete your own account via admin API.' }) };

            await db.delete(users).where(eq(users.id, uid));
            await audit(db, adminId, 'DELETE', 'users', uid);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true }),
            };
        }

        // ── GET: support tickets ──────────────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'tickets') {
            const page = Math.max(0, parseInt(qs.page || '0'));
            const statusFilter = qs.status;
            const categoryFilter = qs.category;

            let condition: any;
            if (statusFilter && categoryFilter) {
                condition = and(eq(supportTickets.status, statusFilter), eq(supportTickets.category, categoryFilter));
            } else if (statusFilter) {
                condition = eq(supportTickets.status, statusFilter);
            } else if (categoryFilter) {
                condition = eq(supportTickets.category, categoryFilter);
            }

            const rows = await db
                .select({
                    id: supportTickets.id,
                    subject: supportTickets.subject,
                    category: supportTickets.category,
                    status: supportTickets.status,
                    priority: supportTickets.priority,
                    assignedTo: supportTickets.assignedTo,
                    createdAt: supportTickets.createdAt,
                    updatedAt: supportTickets.updatedAt,
                    slaBreachedAt: supportTickets.slaBreachedAt,
                    userEmail: users.email,
                    userFirstName: users.firstName,
                    userLastName: users.lastName,
                })
                .from(supportTickets)
                .innerJoin(users, eq(users.id, supportTickets.userId))
                .where(condition)
                .orderBy(desc(supportTickets.createdAt))
                .limit(PAGE_SIZE)
                .offset(page * PAGE_SIZE);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tickets: rows }),
            };
        }

        // ── GET: assistant catalog (admin view) ───────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'catalog') {
            const rows = await db.select().from(masterAssistants).orderBy(masterAssistants.id);
            const wlCounts = await db
                .select({ masterAssistantId: waitlist.masterAssistantId, c: count() })
                .from(waitlist)
                .groupBy(waitlist.masterAssistantId);
            const cmap = Object.fromEntries(wlCounts.map(r => [r.masterAssistantId, r.c]));

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ catalog: rows.map(r => ({ ...r, waitlistCount: cmap[r.id] ?? 0 })) }),
            };
        }

        // ── PATCH: catalog toggle ─────────────────────────────────────────────
        if (event.httpMethod === 'PATCH' && resource === 'catalog') {
            const id = parseInt(qs.id || '');
            if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const body = JSON.parse(event.body || '{}');
            const allowed = ['comingSoon', 'isActive', 'name', 'description', 'category'];
            const updates: Record<string, any> = {};
            for (const f of allowed) { if (body[f] !== undefined) updates[f] = body[f]; }

            const [updated] = await db.update(masterAssistants).set(updates).where(eq(masterAssistants.id, id)).returning();
            await audit(db, adminId, 'UPDATE', 'master_assistants', id, updates);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assistant: updated }),
            };
        }

        // ── GET: analytics — sign-up counts per role (US9) ───────────────────
        if (event.httpMethod === 'GET' && resource === 'analytics') {
            // Count ai_assistants grouped by role (live sign-ups)
            const byRole = await db
                .select({
                    role: aiAssistants.aiAssistantJobRole,
                    c: count(),
                })
                .from(aiAssistants)
                .groupBy(aiAssistants.aiAssistantJobRole)
                .orderBy(desc(count()));

            // Also count raw leads (pre-registration interest)
            const leadsByRole = await db
                .select({
                    role: leads.opportunityReason,
                    c: count(),
                })
                .from(leads)
                .groupBy(leads.opportunityReason)
                .orderBy(desc(count()));

            // Count waitlist entries per master assistant
            const waitlistByRole = await db
                .select({
                    masterAssistantId: waitlist.masterAssistantId,
                    c: count(),
                })
                .from(waitlist)
                .groupBy(waitlist.masterAssistantId);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ byRole, leadsByRole, waitlistByRole }),
            };
        }

        // ── GET: AI model config (US13) ───────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'model-config') {
            const rows = await db.select().from(aiModelConfig).orderBy(aiModelConfig.slot);
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ configs: rows }),
            };
        }

        // ── PATCH: update model config slot (US13) ────────────────────────────
        if (event.httpMethod === 'PATCH' && resource === 'model-config') {
            const id = parseInt(qs.id || '');
            if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const body = JSON.parse(event.body || '{}');
            const allowed = ['provider', 'model', 'isActive', 'monthlyBudgetCents'];
            const updates: Record<string, any> = { updatedAt: new Date(), updatedBy: adminId };
            for (const f of allowed) { if (body[f] !== undefined) updates[f] = body[f]; }

            const [updated] = await db.update(aiModelConfig).set(updates).where(eq(aiModelConfig.id, id)).returning();
            await audit(db, adminId, 'UPDATE', 'ai_model_config', id, updates);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: updated }),
            };
        }

        return { statusCode: 404, body: JSON.stringify({ error: `Unknown resource: ${resource}` }) };

    } catch (err: any) {
        console.error('[admin-api] Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};
