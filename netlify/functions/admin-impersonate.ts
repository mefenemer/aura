// netlify/functions/admin-impersonate.ts
//
// US-ADM-1.2.1: Admin Impersonation with Scoped Token & Audit Trail
//
// POST /.netlify/functions/admin-impersonate
//   Body: { targetUserId: number, reason: 'support_investigation'|'billing_dispute'|'qa_testing'|'account_recovery' }
//   Cookie: aura_session (must belong to super_admin or platform_admin)
//
// Returns:
//   { impersonationToken: string }   — short-lived JWT (15 min), stored as aura_impersonation cookie
//   The caller's original aura_session is preserved and returned separately so it can be restored on end.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';

const jwtSecret = process.env.JWT_SECRET;

const ALLOWED_REASONS = ['support_investigation', 'billing_dispute', 'qa_testing', 'account_recovery'] as const;
type ImpersonationReason = typeof ALLOWED_REASONS[number];

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed.' }) };
    }
    if (!jwtSecret) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    }

    // ── 1. Authenticate the requesting admin ─────────────────────────────────
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let adminId: number;
    try {
        adminId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    // ── 2. Verify the admin has impersonation rights (super_admin or platform_admin only) ─
    const db = getDb();
    const [adminUser] = await db
        .select({ id: users.id, role: users.role, firstName: users.firstName, email: users.email })
        .from(users)
        .where(eq(users.id, adminId))
        .limit(1);

    if (!adminUser || !['super_admin', 'platform_admin'].includes(adminUser.role || '')) {
        return {
            statusCode: 403,
            body: JSON.stringify({ error: 'Impersonation requires platform_admin or super_admin role.' }),
        };
    }

    // ── 3. Validate request body ──────────────────────────────────────────────
    let body: { targetUserId?: number; reason?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const { targetUserId, reason } = body;
    if (!targetUserId || !reason) {
        return { statusCode: 400, body: JSON.stringify({ error: 'targetUserId and reason are required.' }) };
    }
    if (!ALLOWED_REASONS.includes(reason as ImpersonationReason)) {
        return { statusCode: 400, body: JSON.stringify({ error: `reason must be one of: ${ALLOWED_REASONS.join(', ')}` }) };
    }
    if (targetUserId === adminId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Cannot impersonate yourself.' }) };
    }

    // ── 4. Verify target user exists ──────────────────────────────────────────
    const [targetUser] = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, targetUserId))
        .limit(1);

    if (!targetUser) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Target user not found.' }) };
    }

    // ── 5. Issue scoped impersonation JWT (15 min TTL) ────────────────────────
    const sessionId = crypto.randomUUID();
    const impersonationPayload = {
        userId:              targetUserId,       // acts as this user
        email:               targetUser.email,
        realUserId:          adminId,            // original admin
        realAdminEmail:      adminUser.email,
        realAdminName:       adminUser.firstName || adminUser.email,
        impersonatingUserId: targetUserId,
        targetUserEmail:     targetUser.email,
        targetUserName:      [targetUser.firstName, targetUser.lastName].filter(Boolean).join(' '),
        sessionId,
        scope:               'impersonate',
    };
    const impersonationToken = jwt.sign(impersonationPayload, jwtSecret, { expiresIn: '15m' });

    // Cookie: short-lived, replaces aura_session for the impersonation window
    const impersonationCookie = `aura_session=${impersonationToken}; Path=/; Secure; SameSite=Lax; Max-Age=900`;

    // ── 6. Write audit log ────────────────────────────────────────────────────
    await insertAdminAuditLog({
        adminId,
        action: 'impersonate_start',
        targetType: 'user',
        targetId: targetUserId,
        previousState: null as any,
        newState: { sessionId, reason, targetEmail: targetUser.email },
        reason,
        ipAddress: getAdminIp(event.headers as any),
        userAgent: event.headers['user-agent'] || undefined,
        metadata: { sessionId },
    });

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': impersonationCookie,
        },
        body: JSON.stringify({
            success: true,
            sessionId,
            targetEmail:  targetUser.email,
            targetName:   [targetUser.firstName, targetUser.lastName].filter(Boolean).join(' '),
            expiresIn:    900,
            // Return original admin token so the browser can restore it on end-session
            originalToken: match[1],
        }),
    };
};
