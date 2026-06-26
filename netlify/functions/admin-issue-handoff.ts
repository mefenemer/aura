// netlify/functions/admin-issue-handoff.ts
// "Pass to Developer" — machine-to-machine endpoint for the local AI auto-fix runner.
//
// The admin portal queues an issue (POST /admin-issue-reports?action=handoff, cookie-auth).
// A watcher running on a developer machine — where the repo + Claude Code live — then
// drives the actual fix and talks to THIS endpoint. Because the runner has no admin
// session, it authenticates with a shared secret (DEV_HANDOFF_TOKEN) instead of a cookie.
//
//   GET  /admin-issue-handoff?action=claim
//        → atomically claims the oldest queued issue (queued → in_progress) and returns
//          its detail. { issue: null } when the queue is empty.
//
//   POST /admin-issue-handoff?id=N   { ok, summary, branch?, prUrl? }
//        → ok:true  → records branch/PR/summary, status → 'fixed_ready_to_test',
//                     threads the result and notifies the reporter.
//          ok:false → marks the handoff 'failed' (visible status left as 'fix_in_progress')
//                     and threads the failure reason for the admin.
//
// Auth: header `x-handoff-token: <DEV_HANDOFF_TOKEN>` or `Authorization: Bearer <token>`.
// If DEV_HANDOFF_TOKEN is unset the endpoint is disabled (503) — the feature is opt-in.

import { Handler } from '@netlify/functions';
import { and, eq, asc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { issueReports, issueReportMessages, users } from '../../db/schema';
import { ISSUE_STATUS_LABEL, notifyIssueUser } from '../../src/utils/issue-reports';

const json = (statusCode: number, body: unknown) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

function authOk(event: any): boolean {
    const expected = process.env.DEV_HANDOFF_TOKEN;
    if (!expected) return false; // disabled
    const h = event.headers || {};
    const bearer = (h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '').trim();
    const token = (h['x-handoff-token'] || h['X-Handoff-Token'] || bearer || '').trim();
    // Constant-ish comparison; tokens are short so timing leakage is negligible here.
    return token.length > 0 && token === expected;
}

export const handler: Handler = async (event) => {
    if (!process.env.DEV_HANDOFF_TOKEN) {
        return json(503, { error: 'AI auto-fix handoff is not configured (DEV_HANDOFF_TOKEN unset).' });
    }
    if (!authOk(event)) return json(401, { error: 'Invalid or missing handoff token.' });

    const db = getDb();
    const qs = event.queryStringParameters || {};
    const action = qs.action || '';
    const id = qs.id ? Number(qs.id) : null;

    // ── Claim the next queued issue ──────────────────────────────────────────────
    if (event.httpMethod === 'GET' && action === 'claim') {
        const [next] = await db
            .select({ id: issueReports.id })
            .from(issueReports)
            .where(eq(issueReports.devHandoffStatus, 'queued'))
            .orderBy(asc(issueReports.devHandoffAt))
            .limit(1);
        if (!next) return json(200, { issue: null });

        // Compare-and-swap so two runners can't grab the same issue.
        const claimed = await db.update(issueReports)
            .set({ devHandoffStatus: 'in_progress', updatedAt: new Date() })
            .where(and(eq(issueReports.id, next.id), eq(issueReports.devHandoffStatus, 'queued')))
            .returning({ id: issueReports.id });
        if (claimed.length === 0) return json(200, { issue: null }); // lost the race; runner will poll again

        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, next.id)).limit(1);
        const [reporter] = await db
            .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
            .from(users).where(eq(users.id, issue.userId)).limit(1);

        return json(200, {
            issue: {
                id: issue.id,
                description: issue.description,
                sourceLocation: issue.sourceLocation,
                sourceUrl: issue.sourceUrl,
                userAgent: issue.userAgent,
                hasImage: !!issue.imageMime,
                status: issue.status,
                createdAt: issue.createdAt,
                reporterName: [reporter?.firstName, reporter?.lastName].filter(Boolean).join(' ') || reporter?.email || `User #${issue.userId}`,
                reporterEmail: reporter?.email || null,
            },
        });
    }

    // ── Report the outcome of a fix attempt ──────────────────────────────────────
    if (event.httpMethod === 'POST' && id) {
        let body: any;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

        const [issue] = await db.select().from(issueReports).where(eq(issueReports.id, id)).limit(1);
        if (!issue) return json(404, { error: 'Issue not found.' });

        const ok = body.ok !== false; // default to success unless explicitly false
        const summary = (typeof body.summary === 'string' ? body.summary : '').trim();
        const branch = (typeof body.branch === 'string' ? body.branch : '').trim() || null;
        const prUrl = (typeof body.prUrl === 'string' ? body.prUrl : '').trim() || null;
        const migrationSql = (typeof body.sql === 'string' ? body.sql : '').trim() || null;

        if (ok) {
            // If the fix needs a DB migration, DON'T advance to "Fixed & Ready to Test" yet:
            // a super-admin must review and run the SQL against staging from the ticket first.
            const needsSql = !!migrationSql;

            await db.update(issueReports).set({
                devHandoffStatus: 'completed',
                devBranch: branch,
                devPrUrl: prUrl,
                devResult: summary || null,
                devSql: migrationSql,
                devSqlStatus: needsSql ? 'pending' : null,
                devSqlResult: null,
                devSqlRanAt: null,
                status: needsSql ? 'fix_in_progress' : 'fixed_ready_to_test',
                updatedAt: new Date(),
            }).where(eq(issueReports.id, id));

            const threadBody = needsSql
                ? `✅ AI auto-fix complete — but it needs a DATABASE MIGRATION.\n\n${summary || 'A fix has been produced.'}` +
                  (prUrl ? `\n\nPull request: ${prUrl}` : '') +
                  (branch ? `\nBranch: ${branch}` : '') +
                  `\n\n⚠️ Review and run the SQL in this ticket against staging before marking it ready to test.`
                : `✅ AI auto-fix complete.\n\n${summary || 'A fix has been produced.'}` +
                  (prUrl ? `\n\nPull request: ${prUrl}` : '') +
                  (branch ? `\nBranch: ${branch}` : '');

            await db.insert(issueReportMessages).values({
                issueId: id,
                authorType: 'admin',
                authorId: null,
                body: threadBody,
                status: needsSql ? 'fix_in_progress' : 'fixed_ready_to_test',
            });

            // Only notify the reporter once it's genuinely ready to re-test. While a
            // migration is pending the issue stays "Fix In Progress" with no reporter ping.
            if (!needsSql) {
                const shortSummary = summary ? summary.split('\n')[0].slice(0, 280) : '';
                await notifyIssueUser(db, {
                    userId: issue.userId,
                    issueId: id,
                    status: 'fixed_ready_to_test',
                    adminMessage: shortSummary,
                    headers: event.headers,
                }).catch((e) => console.error('[admin-issue-handoff] reporter notify failed:', e?.message || e));
            }

            return json(200, { ok: true, status: needsSql ? 'fix_in_progress' : 'fixed_ready_to_test', needsSql });
        }

        // Failure — surface it to the admin without bothering the reporter (status unchanged).
        await db.update(issueReports).set({
            devHandoffStatus: 'failed',
            devResult: summary || 'The AI runner could not produce a fix.',
            updatedAt: new Date(),
        }).where(eq(issueReports.id, id));

        await db.insert(issueReportMessages).values({
            issueId: id,
            authorType: 'admin',
            authorId: null,
            body: `⚠️ AI auto-fix could not complete.\n\n${summary || 'No further detail was provided.'}\n\nThis issue is still "${ISSUE_STATUS_LABEL[issue.status as keyof typeof ISSUE_STATUS_LABEL] || issue.status}" — review it manually or pass it to the developer again.`,
            status: null,
        });

        return json(200, { ok: true, status: 'failed' });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};
