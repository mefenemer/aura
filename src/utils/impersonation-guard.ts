/**
 * src/utils/impersonation-guard.ts
 *
 * US-ADM-1.2.1: Guard that blocks destructive actions during impersonation sessions.
 *
 * Usage:
 *   const blocked = checkImpersonationBlock(event);
 *   if (blocked) return blocked;
 */

import jwt from 'jsonwebtoken';

const jwtSecret = process.env.JWT_SECRET;

/**
 * Returns a 403 response object if the request is being made under an
 * impersonation session, otherwise returns null (allow).
 */
export function checkImpersonationBlock(
    event: { headers: Record<string, string | undefined> }
): { statusCode: number; body: string } | null {
    if (!jwtSecret) return null;
    try {
        const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
        if (!match) return null;
        const payload = jwt.verify(match[1], jwtSecret) as Record<string, unknown>;
        if (payload.scope === 'impersonate') {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'Action blocked during impersonation session.' }),
            };
        }
    } catch { /* expired / invalid — allow the normal auth flow to handle it */ }
    return null;
}
