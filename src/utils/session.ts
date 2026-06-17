// src/utils/session.ts
// US-DB-1.3.1: Centralised session parsing for Netlify functions.
//
// Replaces the ~109 inlined cookie-parse + jwt.verify blocks scattered across
// functions with one helper. The session may carry an `activeOrganisationId`
// claim (added in Phase 2) — it is OPTIONAL here so older 7-day tokens that
// predate the claim still parse. The claim is only ever used to *select* the
// active tenant; authorisation is always re-verified against userOrganisations
// (see src/utils/tenant.ts).

import type { HandlerEvent } from '@netlify/functions';
import jwt from 'jsonwebtoken';

const jwtSecret = process.env.JWT_SECRET;

export interface Session {
    userId: number;
    /** Active tenant selected at login / via org-switch. Absent on legacy tokens. */
    activeOrganisationId?: number;
    email?: string;
    /** Platform role claim, e.g. 'admin' | 'super_admin'. Distinct from per-org role. */
    adminRole?: string;
}

/** Ready-to-return Netlify response shape used by the 401 helpers. */
export interface JsonResponse {
    statusCode: number;
    body: string;
}

/**
 * Parse and verify the `aura_session` cookie. Returns the decoded session, or
 * null when the cookie is missing/invalid or JWT_SECRET is unset.
 *
 * Tolerant of both cookie encodings seen in the codebase (manual split and the
 * `aura_session=([^;]+)` regex form).
 */
export function getSession(event: HandlerEvent): Session | null {
    if (!jwtSecret) return null;
    const token = readSessionCookie(event.headers?.cookie);
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, jwtSecret) as Record<string, unknown>;
        if (typeof decoded.userId !== 'number') return null;
        return {
            userId: decoded.userId,
            activeOrganisationId:
                typeof decoded.activeOrganisationId === 'number' ? decoded.activeOrganisationId : undefined,
            email: typeof decoded.email === 'string' ? decoded.email : undefined,
            adminRole: typeof decoded.adminRole === 'string' ? decoded.adminRole : undefined,
        };
    } catch {
        return null;
    }
}

/**
 * Like getSession, but returns a discriminated result so callers can short-circuit:
 *
 *   const s = requireSession(event);
 *   if ('error' in s) return s.error;
 *   // s.userId, s.activeOrganisationId available here
 */
export function requireSession(event: HandlerEvent): Session | { error: JsonResponse } {
    if (!jwtSecret) {
        return { error: { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) } };
    }
    const session = getSession(event);
    if (!session) {
        return { error: { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) } };
    }
    return session;
}

/** Extract the raw aura_session token from a Cookie header. */
function readSessionCookie(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === 'aura_session') {
            const value = rest.join('=');
            return value ? decodeURIComponent(value) : null;
        }
    }
    return null;
}
