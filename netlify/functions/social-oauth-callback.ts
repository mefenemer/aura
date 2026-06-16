// netlify/functions/social-oauth-callback.ts
// US-SMM-4.1.1: OAuth 2.0 callback/token exchange for LinkedIn and X (Twitter).
// GET ?platform=linkedin|x&code=...&state=...

import { Handler } from '@netlify/functions';
import { createHmac } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections, notifications, auditLogs, users, userOrganisations } from '../../db/schema';
import { storeSecret } from '../../src/utils/vault';

const jwtSecret = process.env.JWT_SECRET!;
if (!process.env.BASE_URL) throw new Error('CRITICAL: BASE_URL env var is not set');
const baseUrl = process.env.BASE_URL;

function parseState(raw: string): Record<string, string> | null {
    try { return JSON.parse(Buffer.from(raw, 'base64url').toString()); }
    catch { return null; }
}

function validateCsrf(state: Record<string, string>): boolean {
    const expected = createHmac('sha256', jwtSecret).update(state.csrf ?? '').digest('hex');
    return expected === state.csrfHmac;
}

export const handler: Handler = async (event) => {
    const platform = event.queryStringParameters?.platform;
    const { code, state: rawState, error } = event.queryStringParameters ?? {};

    if (error) {
        return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=access_denied&platform=${platform}` }, body: '' };
    }
    if (!code || !rawState || !platform) {
        return { statusCode: 400, body: 'Missing required parameters' };
    }

    const state = parseState(rawState);
    if (!state || !validateCsrf(state)) {
        return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=csrf_fail&platform=${platform}` }, body: '' };
    }

    const organisationId = parseInt(state.organisationId);
    const userId = parseInt(state.userId);
    const db = getDb();
    const callbackUri = `${baseUrl}/.netlify/functions/social-oauth-callback?platform=${platform}`;

    // ── LinkedIn ──────────────────────────────────────────────────────────────
    if (platform === 'linkedin') {
        const clientId     = process.env.LINKEDIN_CLIENT_ID!;
        const clientSecret = process.env.LINKEDIN_CLIENT_SECRET!;

        const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUri, client_id: clientId, client_secret: clientSecret }),
        });
        const tokenData: { access_token?: string; expires_in?: number; error_description?: string } = await tokenRes.json();
        if (!tokenData.access_token) {
            return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=token_exchange&platform=linkedin` }, body: '' };
        }

        // Fetch basic profile to get URN for future API calls
        const profileRes = await fetch('https://api.linkedin.com/v2/me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const profile: { id?: string; localizedFirstName?: string; localizedLastName?: string } = await profileRes.json();
        const linkedinId = profile.id ?? 'unknown';

        const refKey = `aura/org-${organisationId}/linkedin-token`;
        await storeSecret(db, refKey, { token: tokenData.access_token });

        const tokenExpiresAt = tokenData.expires_in
            ? new Date(Date.now() + tokenData.expires_in * 1000)
            : null;

        const [existing] = await db.select({ id: systemConnections.id })
            .from(systemConnections)
            .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, 'linkedin')))
            .limit(1);

        const scopes = 'r_liteprofile,r_emailaddress,w_member_social,r_organization_social,w_organization_social';
        if (existing) {
            await db.update(systemConnections).set({ vaultRefKey: refKey, externalUserId: linkedinId, tokenExpiresAt, status: 'active', isActive: true, scopes, updatedAt: new Date() }).where(eq(systemConnections.id, existing.id));
        } else {
            await db.insert(systemConnections).values({ organisationId, userId, serviceName: 'linkedin', connectionType: 'oauth', vaultRefKey: refKey, externalUserId: linkedinId, tokenExpiresAt, status: 'active', isActive: true, scopes });
        }

        await db.insert(notifications).values({ userId, type: 'linkedin_connected', title: existing ? 'LinkedIn reconnected' : 'LinkedIn connected', message: 'LinkedIn connected successfully. Your assistant can now post on your behalf.' });
        await db.insert(auditLogs).values({ actionType: existing ? 'linkedin_reconnected' : 'linkedin_connected', resourceType: 'system_connections', resourceId: linkedinId, newState: { organisationId } });

        // Trigger pre-flight audit
        fetch(`${baseUrl}/.netlify/functions/social-preflight-audit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organisationId, platform: 'linkedin' }),
        }).catch(() => {});

        return { statusCode: 302, headers: { Location: `/workspace.html?oauth_success=connected&platform=linkedin` }, body: '' };
    }

    // ── X (Twitter) ───────────────────────────────────────────────────────────
    if (platform === 'x') {
        const clientId     = process.env.X_CLIENT_ID!;
        const clientSecret = process.env.X_CLIENT_SECRET!;
        const codeVerifier = state.codeVerifier;

        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` },
            body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUri, code_verifier: codeVerifier ?? '' }),
        });
        const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } = await tokenRes.json();
        if (!tokenData.access_token) {
            return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=token_exchange&platform=x` }, body: '' };
        }

        const meRes = await fetch('https://api.twitter.com/2/users/me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const meData: { data?: { id: string; username: string } } = await meRes.json();
        const xUserId = meData.data?.id ?? 'unknown';
        const xUsername = meData.data?.username ?? '';

        const refKey = `aura/org-${organisationId}/x-token`;
        await storeSecret(db, refKey, { token: tokenData.access_token, refreshToken: tokenData.refresh_token ?? null });

        const tokenExpiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

        const [existing] = await db.select({ id: systemConnections.id })
            .from(systemConnections)
            .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, 'x')))
            .limit(1);

        const scopes = 'tweet.read,tweet.write,users.read,offline.access';
        if (existing) {
            await db.update(systemConnections).set({ vaultRefKey: refKey, externalUserId: xUsername || xUserId, tokenExpiresAt, status: 'active', isActive: true, scopes, updatedAt: new Date() }).where(eq(systemConnections.id, existing.id));
        } else {
            await db.insert(systemConnections).values({ organisationId, userId, serviceName: 'x', connectionType: 'oauth', vaultRefKey: refKey, externalUserId: xUsername || xUserId, tokenExpiresAt, status: 'active', isActive: true, scopes });
        }

        await db.insert(notifications).values({ userId, type: 'x_connected', title: existing ? 'X reconnected' : 'X connected', message: 'X (Twitter) connected successfully. Your assistant can now post on your behalf.' });
        await db.insert(auditLogs).values({ actionType: existing ? 'x_reconnected' : 'x_connected', resourceType: 'system_connections', resourceId: xUserId, newState: { organisationId, username: xUsername } });

        return { statusCode: 302, headers: { Location: `/workspace.html?oauth_success=connected&platform=x` }, body: '' };
    }

    return { statusCode: 400, body: 'Unknown platform' };
};
