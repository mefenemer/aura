// netlify/functions/social-oauth-init.ts
// US-SMM-4.1.1: OAuth 2.0 initiation for LinkedIn and X (Twitter).
// GET ?platform=linkedin|x  — validates session, builds redirect URL with CSRF state.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { createHmac, randomBytes } from 'crypto';

const jwtSecret = process.env.JWT_SECRET!;
if (!process.env.BASE_URL) throw new Error('CRITICAL: BASE_URL env var is not set');
const baseUrl = process.env.BASE_URL;

function buildState(payload: object): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export const handler: Handler = async (event) => {
    const platform = event.queryStringParameters?.platform;
    if (!['linkedin', 'x'].includes(platform ?? '')) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Unknown platform' }) };
    }

    const cookieHeader = event.headers.cookie || '';
    const sessionToken = cookieHeader.match(/aura_session=([^;]+)/)?.[1];
    if (!sessionToken) return { statusCode: 302, headers: { Location: '/workspace.html?oauth_error=unauthenticated' }, body: '' };

    let userId: number;
    let organisationId: number;
    try {
        const p = jwt.verify(sessionToken, jwtSecret) as { userId: number; organisationId: number };
        userId = p.userId;
        organisationId = p.organisationId;
    } catch {
        return { statusCode: 302, headers: { Location: '/workspace.html?oauth_error=invalid_session' }, body: '' };
    }

    const csrf = randomBytes(32).toString('hex');
    const csrfHmac = createHmac('sha256', jwtSecret).update(csrf).digest('hex');
    const state = buildState({ platform, userId: String(userId), organisationId: String(organisationId), csrf, csrfHmac });

    const callbackUri = `${baseUrl}/.netlify/functions/social-oauth-callback?platform=${platform}`;

    let authUrl: string;

    if (platform === 'linkedin') {
        const clientId = process.env.LINKEDIN_CLIENT_ID;
        if (!clientId) return { statusCode: 500, body: 'LinkedIn OAuth not configured' };
        const scopes = 'r_liteprofile,r_emailaddress,w_member_social,r_organization_social,w_organization_social';
        authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUri)}&scope=${encodeURIComponent(scopes)}&state=${state}`;
    } else {
        // X OAuth 2.0 with PKCE
        const clientId = process.env.X_CLIENT_ID;
        if (!clientId) return { statusCode: 500, body: 'X OAuth not configured' };
        const codeVerifier = randomBytes(32).toString('base64url');
        const { createHash } = await import('crypto');
        const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
        // Embed codeVerifier in state so callback can use it
        const xState = buildState({ platform, userId: String(userId), organisationId: String(organisationId), csrf, csrfHmac, codeVerifier });
        const scopes = 'tweet.read tweet.write users.read offline.access';
        authUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUri)}&scope=${encodeURIComponent(scopes)}&state=${xState}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
        return { statusCode: 302, headers: { Location: authUrl }, body: '' };
    }

    return { statusCode: 302, headers: { Location: authUrl }, body: '' };
};
