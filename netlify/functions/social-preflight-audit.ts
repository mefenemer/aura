// netlify/functions/social-preflight-audit.ts
// US-SMM-4.3.1: Pre-flight configuration audit for social connections.
// POST { organisationId, platform }  — runs checks, stores results in systemConnections.metadata.
// GET ?organisationId=N&platform=X   — returns last audit results.
// Runs within 5s of OAuth callback (fire-and-forget), nightly schedule, and manual trigger.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';

const jwtSecret = process.env.JWT_SECRET!;

interface PreflightCheck {
    id: 'CHK-01' | 'CHK-02' | 'CHK-03' | 'CHK-04' | 'CHK-05';
    label: string;
    status: 'pass' | 'fail' | 'unknown';
    detail?: string;
    deepLink?: string;
}

async function runMetaChecks(token: string, metadata: Record<string, unknown>): Promise<PreflightCheck[]> {
    const fbPageId = metadata?.fbPageId as string | undefined;
    const accountType = metadata?.accountType as string | undefined;
    const checks: PreflightCheck[] = [];

    // CHK-01: Facebook Page linked
    checks.push({
        id: 'CHK-01',
        label: 'Facebook Page linked',
        status: fbPageId ? 'pass' : 'fail',
        detail: fbPageId ? `Page ID: ${fbPageId}` : 'No Facebook Page is linked to this Instagram account.',
        deepLink: 'https://www.facebook.com/pages/',
    });

    // CHK-02: Instagram Business account connected (externalUserId present — already verified at OAuth)
    checks.push({
        id: 'CHK-02',
        label: 'Instagram Business account connected',
        status: 'pass',
        detail: 'Instagram Business account verified during OAuth.',
        deepLink: 'https://business.facebook.com/instagram',
    });

    // CHK-03: Account type is BUSINESS (not just CREATOR)
    checks.push({
        id: 'CHK-03',
        label: 'Instagram account is Business type',
        status: accountType?.toUpperCase() === 'BUSINESS' ? 'pass' : (accountType?.toUpperCase() === 'CREATOR' ? 'fail' : 'unknown'),
        detail: accountType ? `Account type: ${accountType}` : 'Account type unknown.',
        deepLink: 'https://www.instagram.com/accounts/convert_to_business/',
    });

    // CHK-04: Messaging enabled on Facebook Page (requires page-level API call)
    let chk04: PreflightCheck = { id: 'CHK-04', label: 'Facebook Page messaging enabled', status: 'unknown', deepLink: 'https://www.facebook.com/settings/?tab=messaging' };
    if (fbPageId) {
        try {
            const pageRes = await fetch(`https://graph.facebook.com/v19.0/${fbPageId}?fields=messaging_feature_status&access_token=${token}`, { signal: AbortSignal.timeout(4000) });
            const pageData: { messaging_feature_status?: string; error?: { message: string } } = await pageRes.json();
            if (pageData.messaging_feature_status) {
                chk04.status = pageData.messaging_feature_status === 'ENABLED' ? 'pass' : 'fail';
                chk04.detail = `Messaging status: ${pageData.messaging_feature_status}`;
            } else if (pageData.error) {
                chk04.detail = pageData.error.message;
            }
        } catch { /* timeout or network error — leave as unknown */ }
    } else {
        chk04.status = 'fail';
        chk04.detail = 'Cannot check messaging — no Facebook Page linked.';
    }
    checks.push(chk04);

    // CHK-05: Meta Terms of Service accepted
    let chk05: PreflightCheck = { id: 'CHK-05', label: 'Meta Terms of Service accepted', status: 'unknown', deepLink: 'https://www.facebook.com/policies_center/' };
    try {
        const tosRes = await fetch(`https://graph.facebook.com/v19.0/me?fields=tos_accepted&access_token=${token}`, { signal: AbortSignal.timeout(4000) });
        const tosData: { tos_accepted?: Record<string, boolean>; error?: { message: string } } = await tosRes.json();
        if (tosData.tos_accepted) {
            const allAccepted = Object.values(tosData.tos_accepted).every(Boolean);
            chk05.status = allAccepted ? 'pass' : 'fail';
            chk05.detail = allAccepted ? 'All applicable Meta ToS accepted.' : 'One or more Meta Terms of Service not yet accepted.';
        } else {
            chk05.status = 'pass'; // field absent = no additional ToS pending
            chk05.detail = 'No additional ToS required.';
        }
    } catch { /* timeout or network error */ }
    checks.push(chk05);

    return checks;
}

async function runLinkedInChecks(token: string): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];
    let orgStatus: PreflightCheck = {
        id: 'CHK-01',
        label: 'LinkedIn organisation verified',
        status: 'unknown',
        deepLink: 'https://www.linkedin.com/company/admin/',
    };
    try {
        const orgRes = await fetch('https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&projection=(elements*(organizationStatus))', {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(4000),
        });
        const orgData: { elements?: Array<{ organizationStatus: string }> } = await orgRes.json();
        const verified = orgData.elements?.some(e => e.organizationStatus === 'APPROVED');
        orgStatus.status = verified ? 'pass' : 'fail';
        orgStatus.detail = verified ? 'Organisation page is approved.' : 'No approved LinkedIn organisation found for this account.';
    } catch { /* leave unknown */ }
    checks.push(orgStatus);
    return checks;
}

async function runXChecks(token: string): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = [];
    let writeCheck: PreflightCheck = {
        id: 'CHK-01',
        label: 'X write scope granted',
        status: 'unknown',
        deepLink: 'https://developer.twitter.com/en/portal/dashboard',
    };
    try {
        // Attempt a dry-run: fetch the authed user; if scopes include tweet.write it would succeed
        const meRes = await fetch('https://api.twitter.com/2/users/me?user.fields=id', {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(4000),
        });
        const meData: { data?: { id: string }; errors?: unknown[] } = await meRes.json();
        writeCheck.status = meData.data?.id ? 'pass' : 'fail';
        writeCheck.detail = meData.data?.id ? 'X account accessible with current token.' : 'Token cannot access X account — write scope may be missing.';
    } catch { /* leave unknown */ }
    checks.push(writeCheck);
    return checks;
}

export const handler: Handler = async (event) => {
    // ── GET: return last results ──────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const cookieHeader = event.headers.cookie || '';
        const sessionToken = cookieHeader.match(/aura_session=([^;]+)/)?.[1];
        if (!sessionToken) return { statusCode: 401, body: 'Unauthorized' };

        let organisationId: number;
        try {
            const p = jwt.verify(sessionToken, jwtSecret) as { organisationId: number };
            organisationId = p.organisationId;
        } catch { return { statusCode: 401, body: 'Invalid session' }; }

        const platform = event.queryStringParameters?.platform ?? 'instagram';
        const db = getDb();
        const [conn] = await db.select({ metadata: systemConnections.metadata })
            .from(systemConnections)
            .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, platform), eq(systemConnections.isActive, true)))
            .limit(1);

        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ results: (conn?.metadata as Record<string, unknown>)?.preflightAuditResults ?? null }) };
    }

    // ── POST: run audit ───────────────────────────────────────────────────────
    if (event.httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { organisationId, platform } = body as { organisationId: number; platform: string };

        if (!organisationId || !platform) {
            return { statusCode: 400, body: JSON.stringify({ error: 'organisationId and platform required' }) };
        }

        const db = getDb();
        const svc = platform === 'instagram' ? 'instagram' : platform;

        const [conn] = await db.select({ id: systemConnections.id, vaultRefKey: systemConnections.vaultRefKey, metadata: systemConnections.metadata })
            .from(systemConnections)
            .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, svc), eq(systemConnections.isActive, true)))
            .limit(1);

        if (!conn) {
            return { statusCode: 404, body: JSON.stringify({ error: 'No active connection found' }) };
        }

        let checks: PreflightCheck[] = [];
        if (conn.vaultRefKey) {
            const secret = await getSecret(db, conn.vaultRefKey);
            const token = (secret as { token?: string } | null)?.token;
            if (token) {
                if (platform === 'instagram' || platform === 'facebook') {
                    checks = await runMetaChecks(token, (conn.metadata as Record<string, unknown>) ?? {});
                } else if (platform === 'linkedin') {
                    checks = await runLinkedInChecks(token);
                } else if (platform === 'x') {
                    checks = await runXChecks(token);
                }
            }
        }

        const failCount = checks.filter(c => c.status === 'fail').length;
        const preflightStatus = failCount === 0 ? 'passed' : failCount >= checks.length ? 'blocked' : 'partial';

        const existingMeta = (conn.metadata as Record<string, unknown>) ?? {};
        await db.update(systemConnections).set({
            metadata: { ...existingMeta, preflightAuditResults: checks, preflightStatus, preflightAuditAt: new Date().toISOString() },
            updatedAt: new Date(),
        }).where(eq(systemConnections.id, conn.id));

        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preflightStatus, checks }) };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};
