// src/utils/impersonation.ts
// US-ADM-1.2.1: Helpers for detecting and blocking actions during admin impersonation.
//
// Other endpoints import checkImpersonationBlock() and call it before any action
// that must be blocked during impersonation (Stripe charges, account deletion,
// password changes, data exports).

import jwt from 'jsonwebtoken';
import type { ImpersonationPayload } from '../../netlify/functions/admin-impersonate';

const jwtSecret = process.env.JWT_SECRET;

/**
 * Parse the aura_impersonation cookie if present and valid.
 * Returns null when not in an impersonation session.
 */
export function getImpersonationSession(cookieHeader: string | undefined): ImpersonationPayload | null {
    if (!cookieHeader || !jwtSecret) return null;
    const match = cookieHeader.match(/aura_impersonation=([^;]+)/);
    if (!match) return null;
    try {
        const payload = jwt.verify(match[1], jwtSecret) as ImpersonationPayload;
        return payload.scope === 'impersonate' ? payload : null;
    } catch {
        return null;
    }
}

/**
 * Returns a 403 response body if the request is in an impersonation session,
 * otherwise returns null (safe to proceed).
 *
 * Usage in a Netlify function:
 *   const block = checkImpersonationBlock(event.headers.cookie, 'billing_upgrade');
 *   if (block) return block;
 */
export function checkImpersonationBlock(
    cookieHeader: string | undefined,
    blockedAction: string,
): { statusCode: number; body: string } | null {
    const session = getImpersonationSession(cookieHeader);
    if (!session) return null;
    return {
        statusCode: 403,
        body: JSON.stringify({
            error: `Action "${blockedAction}" is not permitted during an admin impersonation session.`,
            impersonationSessionId: session.sessionId,
        }),
    };
}
