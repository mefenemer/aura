// netlify/functions/admin-issue-reports.ts
// Testing-phase "Report an Issue" — Admin Portal API (Testing section).
//
// GET   /admin-issue-reports                     → all issues (newest first), optional ?status=
// GET   /admin-issue-reports?id=N                → single issue + full message thread + screenshot
// PATCH /admin-issue-reports?id=N { status?, message? }
//                                                → update status and/or post a supporting message,
//                                                  then notify the reporting user (in-app + email).
//
// Admin-only (users.role IN admin roles). On every status change the user is notified so they
// can re-test the fix or supply more information.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq, desc, asc, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { issueReports, issueReportMessages, users, notifications } from '../../db/schema';
import { isAdminRole } from '../../src/utils/rbac';
import { sendEmail } from '../../src/utils/email';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { ISSUE_STATUS_LABEL, isIssueStatus, type IssueStatus } from '../../src/utils/issue-reports';

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

    // ── GET single issue (with thread + screenshot) ──────────────────────────────
    if (event.httpMethod === 'GET' && id) {
        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });
        const [reporter] = await db
            .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
            .from(users).where(eq(users.id, issue.userId)).limit(1);
        const messages = await db.select().from(issueReportMessages)
            .where(eq(issueReportMessages.issueId, id))
            .orderBy(asc(issueReportMessages.createdAt));
        return json(200, {
            issue: {
                ...issue,
                statusLabel: ISSUE_STATUS_LABEL[issue.status as IssueStatus] || issue.status,
                reporterName: [reporter?.firstName, reporter?.lastName].filter(Boolean).join(' ') || reporter?.email || `User #${issue.userId}`,
                reporterEmail: reporter?.email || null,
            },
            messages,
        });
    }

    // ── GET list ─────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const status = qs.status && isIssueStatus(qs.status) ? qs.status : null;
        const where = status ? eq(issueReports.status, status) : undefined;
        const rows = await db
            .select({
                id: issueReports.id,
                userId: issueReports.userId,
                description: issueReports.description,
                sourceLocation: issueReports.sourceLocation,
                status: issueReports.status,
                imageMime: issueReports.imageMime,
                createdAt: issueReports.createdAt,
                updatedAt: issueReports.updatedAt,
                reporterEmail: users.email,
                reporterFirst: users.firstName,
                reporterLast: users.lastName,
            })
            .from(issueReports)
            .leftJoin(users, eq(users.id, issueReports.userId))
            .where(where as any)
            .orderBy(desc(issueReports.createdAt))
            .limit(300);

        // Status counts for the filter chips.
        const counts = await db
            .select({ status: issueReports.status, n: sql<number>`count(*)::int` })
            .from(issueReports)
            .groupBy(issueReports.status);

        return json(200, {
            issues: rows.map((r) => ({
                id: r.id,
                description: r.description,
                sourceLocation: r.sourceLocation,
                status: r.status,
                statusLabel: ISSUE_STATUS_LABEL[r.status as IssueStatus] || r.status,
                hasImage: !!r.imageMime,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
                reporterName: [r.reporterFirst, r.reporterLast].filter(Boolean).join(' ') || r.reporterEmail || `User #${r.userId}`,
                reporterEmail: r.reporterEmail,
            })),
            counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
        });
    }

    // ── PATCH: update status and/or post a message, then notify the user ─────────
    if (event.httpMethod === 'PATCH' && id) {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });

        const newStatus: IssueStatus | null = isIssueStatus(body.status) ? body.status : null;
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!newStatus && !message) return json(400, { error: 'Provide a status and/or a message.' });

        const finalStatus = newStatus || (issue.status as IssueStatus);

        if (newStatus) {
            await db.update(issueReports)
                .set({
                    status: newStatus,
                    updatedAt: new Date(),
                    resolvedAt: newStatus === 'closed' ? new Date() : issue.resolvedAt,
                })
                .where(eq(issueReports.id, id));
        }

        // Record the supporting message / status change in the thread.
        if (message || newStatus) {
            await db.insert(issueReportMessages).values({
                issueId: id,
                authorType: 'admin',
                authorId: admin.id,
                body: message || `Status changed to "${ISSUE_STATUS_LABEL[finalStatus]}".`,
                status: newStatus,
            });
        }

        // Notify the reporting user so they can act (re-test or supply more info).
        await notifyUser(db, issue.userId, id, finalStatus, message, event.headers)
            .catch((e) => console.error('[admin-issue-reports] user notify failed:', e?.message || e));

        return json(200, { ok: true, status: finalStatus });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};

async function notifyUser(
    db: ReturnType<typeof getDb>,
    userId: number,
    issueId: number,
    status: IssueStatus,
    adminMessage: string,
    headers: Record<string, string | undefined>,
): Promise<void> {
    const label = ISSUE_STATUS_LABEL[status];

    // Status-specific call to action.
    const cta =
        status === 'fixed_ready_to_test' ? 'Please re-test and confirm the fix worked.' :
        status === 'more_info_required'  ? 'The team needs more information to proceed.' :
        status === 'fix_in_progress'     ? 'A fix is now in progress.' :
        status === 'closed'              ? 'This issue has been closed.' :
        'Your reported issue has been updated.';

    const title =
        status === 'fixed_ready_to_test' ? `✅ Issue #${issueId} fixed — ready to test` :
        status === 'more_info_required'  ? `❓ Issue #${issueId} — more info needed` :
        `🔧 Issue #${issueId} updated: ${label}`;

    const messageLine = adminMessage ? ` — “${adminMessage}”` : '';

    // In-app notification (canonical table). type 'issue_update' defaults to the
    // 'informational' category until/unless added to the categorization map.
    await db.insert(notifications).values({
        userId,
        type: 'issue_update',
        title,
        message: `${cta}${messageLine}`,
        metadata: { issueId, status },
    }).catch((e) => console.error('[admin-issue-reports] notification insert failed:', e?.message || e));

    // Email the user too.
    const [u] = await db.select({ email: users.email, firstName: users.firstName })
        .from(users).where(eq(users.id, userId)).limit(1);
    if (!u?.email) return;

    const base = resolveBaseUrl(headers) || process.env.BASE_URL || 'https://bemoreswan.com';
    const link = `${base}/workspace.html?issue=${issueId}`;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `
        <p>Hi ${esc(u.firstName || 'there')},</p>
        <p>There's an update on the issue you reported (#${issueId}).</p>
        <p><strong>Status:</strong> ${esc(label)}</p>
        <p>${esc(cta)}</p>
        ${adminMessage ? `<blockquote style="border-left:3px solid #e5e7eb;margin:0;padding:8px 16px;color:#374151;white-space:pre-wrap;">${esc(adminMessage)}</blockquote>` : ''}
        <p style="margin-top:24px;">
          <a href="${link}" style="background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
            View in your workspace →
          </a>
        </p>
        <p style="color:#6b7280;font-size:13px;">Thank you for helping us test Be More Swan.</p>`;

    await sendEmail({ to: u.email, subject: title, html })
        .catch((e) => console.error('[admin-issue-reports] email failed:', e?.message || e));
}
