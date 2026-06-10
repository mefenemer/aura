// admin-api.ts  (US6, US8, US9, US13)
// Secure admin-only REST API for the Admin Workspace.
// All endpoints require a valid session AND users.role IN ('admin','super_admin').
//
// GET  /admin-api?resource=dashboard                          → KPIs + subscription tier breakdown
// GET  /admin-api?resource=users[&q=&page=]                  → paginated user list
// GET  /admin-api?resource=user&id=N                         → single user detail
// PATCH /admin-api?resource=user&id=N                        → edit user (status, role, name)
// DELETE /admin-api?resource=user&id=N                       → delete user account
// POST  /admin-api?resource=send-login-link&id=N             → email passwordless link to user (US6 Sc2)
// GET  /admin-api?resource=tickets[&status=&category=&page=] → support ticket list
// GET  /admin-api?resource=admins                            → list of admin users (for assignment dropdown)
// GET  /admin-api?resource=catalog                           → master assistants list
// PATCH /admin-api?resource=catalog&id=N                     → toggle comingSoon / isActive
// GET  /admin-api?resource=analytics[&from=ISO&to=ISO]       → sign-up counts + date filter (US9)
// GET  /admin-api?resource=logs[&page=]                      → paginated audit log (US6 Sc3)
// GET  /admin-api?resource=model-config                      → AI model config rows (US13)
// POST  /admin-api?resource=model-config                     → create new model config slot
// PATCH /admin-api?resource=model-config&id=N                → update a model config slot

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { Resend } from 'resend';
import { eq, ilike, desc, and, or, count, gte, lte } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    users, userProfiles, plans, aiAssistants,
    supportTickets, masterAssistants, waitlist,
    leads, auditLogs, notifications, aiModelConfig,
} from '../../db/schema';
import { sendMagicLinkEmail } from '../../src/utils/email';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || 'hello@aura-assist.com';

const jwtSecret = process.env.JWT_SECRET;
const PAGE_SIZE = 25;

// ── Auth helper — returns userId or null; enforces admin role ─────────────────
async function requireAdmin(event: any): Promise<number | null> {
    if (!jwtSecret) { console.log('[admin-api] FAIL: JWT_SECRET not set'); return null; }
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) { console.log('[admin-api] FAIL: no aura_session cookie. Cookies present:', event.headers.cookie || '(none)'); return null; }
    let userId: number;
    try { userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; }
    catch (e) { console.log('[admin-api] FAIL: JWT verify error:', e.message); return null; }

    console.log('[admin-api] JWT valid, userId:', userId);

    const db = getDb();
    let row: { role: string } | undefined;
    try {
        const rows = await db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
        row = rows[0];
    } catch (e: any) {
        console.log('[admin-api] FAIL: DB query error:', e.message);
        return null;
    }

    if (!row) { console.log('[admin-api] FAIL: user not found in DB for userId:', userId); return null; }
    console.log('[admin-api] user role:', row.role);
    if (!['admin', 'super_admin'].includes(row.role)) { console.log('[admin-api] FAIL: role not admin. Got:', row.role); return null; }
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
        // ── GET: dashboard KPIs (US6 Sc4) ────────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'dashboard') {
            const [totalUsers]      = await db.select({ c: count() }).from(users);
            const [pendingUsers]    = await db.select({ c: count() }).from(users).where(eq(users.status, 'pending_verification'));
            const [activeAssistants]= await db.select({ c: count() }).from(aiAssistants).where(eq(aiAssistants.isActive, true));
            const [pausedAssistants]= await db.select({ c: count() }).from(aiAssistants).where(eq(aiAssistants.isActive, false));
            const [activePlans]     = await db.select({ c: count() }).from(plans).where(eq(plans.status, 'active'));
            const [openTickets]     = await db.select({ c: count() }).from(supportTickets).where(eq(supportTickets.status, 'open'));

            // Subscription tier breakdown (US6 Sc4)
            const tierBreakdown = await db
                .select({ planName: plans.planName, c: count() })
                .from(plans)
                .where(eq(plans.status, 'active'))
                .groupBy(plans.planName)
                .orderBy(desc(count()));

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
                    tierBreakdown,
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

        // ── POST: send passwordless login link to user (US6 Sc2) ─────────────
        if (event.httpMethod === 'POST' && resource === 'send-login-link') {
            const uid = parseInt(qs.id || '');
            if (!uid) return { statusCode: 400, body: JSON.stringify({ error: 'id required.' }) };

            const [targetUser] = await db
                .select({ id: users.id, email: users.email, firstName: users.firstName })
                .from(users).where(eq(users.id, uid)).limit(1);
            if (!targetUser) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };
            if (!targetUser.email) return { statusCode: 400, body: JSON.stringify({ error: 'User has no email address.' }) };

            // Generate a single-use token valid for 24 h
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

            await db.update(users)
                .set({ verificationToken: token, tokenExpiresAt: expiresAt, updatedAt: new Date() })
                .where(eq(users.id, uid));

            const loginUrl = `${process.env.SITE_URL || 'https://aura-assist.com'}/verify.html?token=${token}`;

            if (process.env.RESEND_API_KEY) {
                await resend.emails.send({
                    from: FROM_EMAIL,
                    to: targetUser.email,
                    subject: 'Your Aura Assist Login Link',
                    html: `
<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:#111827;padding:24px 32px">
    <span style="color:#10b981;font-size:22px;font-weight:800">Aura</span><span style="color:#fff;font-size:22px;font-weight:800">-Assist</span>
  </div>
  <div style="padding:32px">
    <h2 style="margin:0 0 12px;color:#111827">Admin-sent login link</h2>
    <p style="color:#6b7280;font-size:15px;line-height:1.6">Hi ${targetUser.firstName || 'there'},<br><br>
      An Aura Assist admin has sent you a one-click login link. Click below to access your account — this link expires in 24 hours.</p>
    <div style="text-align:center;margin:28px 0">
      <a href="${loginUrl}" style="display:inline-block;background:#10b981;color:#fff;font-weight:700;font-size:16px;padding:14px 32px;border-radius:8px;text-decoration:none">Log in to Aura Assist</a>
    </div>
    <p style="margin:0;color:#9ca3af;font-size:13px">If you did not expect this email, you can safely ignore it.</p>
  </div>
</div>`,
                });
            }

            await audit(db, adminId, 'SEND_LOGIN_LINK', 'users', uid);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true, expiresAt }),
            };
        }

        // ── GET: admins list — for ticket assignment dropdown (US7 Sc2) ───────
        if (event.httpMethod === 'GET' && resource === 'admins') {
            const adminUsers = await db
                .select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email, role: users.role })
                .from(users)
                .where(or(eq(users.role, 'admin'), eq(users.role, 'super_admin')))
                .orderBy(users.firstName);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ admins: adminUsers }),
            };
        }

        // ── GET: paginated audit log (US6 Sc3) ────────────────────────────────
        if (event.httpMethod === 'GET' && resource === 'logs') {
            const page = Math.max(0, parseInt(qs.page || '0'));

            const rows = await db
                .select({
                    id: auditLogs.id,
                    actionType: auditLogs.actionType,
                    resourceType: auditLogs.resourceType,
                    resourceId: auditLogs.resourceId,
                    newState: auditLogs.newState,
                    createdAt: auditLogs.createdAt,
                    adminId: auditLogs.userId,
                    adminEmail: users.email,
                    adminFirstName: users.firstName,
                    adminLastName: users.lastName,
                })
                .from(auditLogs)
                .leftJoin(users, eq(users.id, auditLogs.userId))
                .orderBy(desc(auditLogs.createdAt))
                .limit(PAGE_SIZE)
                .offset(page * PAGE_SIZE);

            const [{ c: total }] = await db.select({ c: count() }).from(auditLogs);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ logs: rows, total, page, pageSize: PAGE_SIZE }),
            };
        }

        // ── GET: analytics — sign-up counts per role (US9, with date filter US9 Sc3) ──
        if (event.httpMethod === 'GET' && resource === 'analytics') {
            // Optional date range
            const fromDate = qs.from ? new Date(qs.from) : null;
            const toDate   = qs.to   ? new Date(qs.to)   : null;

            const dateCondition = (col: any) => {
                if (fromDate && toDate) return and(gte(col, fromDate), lte(col, toDate));
                if (fromDate) return gte(col, fromDate);
                if (toDate)   return lte(col, toDate);
                return undefined;
            };

            // Count ai_assistants grouped by role (live sign-ups)
            const byRole = await db
                .select({ role: aiAssistants.aiAssistantJobRole, c: count() })
                .from(aiAssistants)
                .where(dateCondition(aiAssistants.createdAt))
                .groupBy(aiAssistants.aiAssistantJobRole)
                .orderBy(desc(count()));

            // Raw leads (pre-registration interest)
            const leadsByRole = await db
                .select({ role: leads.opportunityReason, c: count() })
                .from(leads)
                .where(dateCondition(leads.createdAt))
                .groupBy(leads.opportunityReason)
                .orderBy(desc(count()));

            // Waitlist entries per master assistant
            const waitlistByRole = await db
                .select({ masterAssistantId: waitlist.masterAssistantId, c: count() })
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

        // ── POST: create new model config slot (US13) ────────────────────────
        if (event.httpMethod === 'POST' && resource === 'model-config') {
            const body = JSON.parse(event.body || '{}');
            const { slot, provider, model, monthlyBudgetCents } = body;
            if (!slot || !model) return { statusCode: 400, body: JSON.stringify({ error: 'slot and model are required.' }) };

            const [created] = await db.insert(aiModelConfig).values({
                slot,
                provider: provider || 'openai',
                model,
                isActive: true,
                monthlyBudgetCents: monthlyBudgetCents ?? null,
                updatedBy: adminId,
            }).returning();

            await audit(db, adminId, 'CREATE', 'ai_model_config', created.id, { slot, model, provider });

            return {
                statusCode: 201,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: created }),
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
