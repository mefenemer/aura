import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, or, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections } from '../../db/schema';
import { encryptCredential } from '../../src/utils/encryption';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    // 1. Session Authentication
    const cookieHeader = event.headers.cookie || '';
    const sessionToken = cookieHeader.match(/aura_session=([^;]+)/)?.[1];

    if (!sessionToken || !jwtSecret) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let currentUserId: number;
    try {
        currentUserId = (jwt.verify(sessionToken, jwtSecret) as { userId: number }).userId;
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    try {
        // --- GET: FETCH INTEGRATIONS DASHBOARD ---
        if (event.httpMethod === 'GET') {
            // 1. Fetch system-wide platform definitions (userId is null)
            // Select only non-sensitive columns — tokens must never leave the server.
            const safeColumns = {
                id: systemConnections.id,
                serviceName: systemConnections.serviceName,
                connectionType: systemConnections.connectionType,
                externalUserId: systemConnections.externalUserId,
                scopes: systemConnections.scopes,
                status: systemConnections.status,
                isActive: systemConnections.isActive,
                metadata: systemConnections.metadata,
                createdAt: systemConnections.createdAt,
                updatedAt: systemConnections.updatedAt,
                tokenExpiresAt: systemConnections.tokenExpiresAt,
            };

            const systemCatalog = await db.select(safeColumns).from(systemConnections).where(isNull(systemConnections.userId));

            // 2. Fetch current user's actual connections (no tokens)
            const userConnections = await db.select(safeColumns).from(systemConnections).where(eq(systemConnections.userId, currentUserId));

            // 3. Merge: user connection overrides the system catalog row for the same service
            const merged = systemCatalog.map(catalog => {
                const userConn = userConnections.find(u => u.serviceName === catalog.serviceName);
                return userConn ? { ...userConn, connected: true } : { ...catalog, connected: false };
            });
            // Also include user connections for services not in the system catalog
            userConnections.forEach(uc => {
                if (!merged.find(m => m.serviceName === uc.serviceName)) {
                    merged.push({ ...uc, connected: true });
                }
            });

            return { statusCode: 200, body: JSON.stringify({ connections: merged }) };
        }

        // --- POST: SECURE CONNECTION CREATION ---
        if (event.httpMethod === 'POST') {
            const body = JSON.parse(event.body || '{}');
            const { serviceName, connectionType, apiKey, handle, pageUrl, scopes } = body;

            if (!serviceName || !apiKey) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Service name and access token are required.' }) };
            }

            // ── Scope Creep guard: whitelist permitted scopes per service ────
            // If scopes are provided, validate them against the allowed set to
            // prevent over-privileged OAuth grants (e.g., requesting write access
            // when only read is needed for the connected workflow).
            const ALLOWED_SCOPES: Record<string, string[]> = {
                facebook:      ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'publish_to_groups'],
                instagram:     ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights'],
                linkedin:      ['r_liteprofile', 'r_emailaddress', 'w_member_social', 'r_organization_social', 'w_organization_social'],
                twitter:       ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
                google:        ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/spreadsheets'],
                openai:        [],  // API key — no scope concept
                notion:        ['read_content', 'update_content', 'insert_content'],
                hubspot:       ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
                slack:         ['channels:read', 'chat:write', 'files:write'],
            };

            const serviceKey = serviceName.toLowerCase();
            if (scopes && Array.isArray(scopes)) {
                const allowed = ALLOWED_SCOPES[serviceKey];
                if (allowed !== undefined) { // known service
                    const forbidden = scopes.filter((s: string) => !allowed.includes(s));
                    if (forbidden.length > 0) {
                        console.warn(`[integrations] Scope creep blocked for ${serviceKey}:`, forbidden);
                        return {
                            statusCode: 400,
                            body: JSON.stringify({
                                error: `The following OAuth scopes are not permitted for ${serviceName}: ${forbidden.join(', ')}`,
                                code: 'SCOPE_NOT_PERMITTED',
                            }),
                        };
                    }
                }
            }

            const encryptedToken = encryptCredential(apiKey);

            // Upsert — if the user already has a connection for this service, replace it
            const existing = await db
                .select({ id: systemConnections.id })
                .from(systemConnections)
                .where(and(eq(systemConnections.userId, currentUserId), eq(systemConnections.serviceName, serviceName)))
                .limit(1);

            const scopeString = Array.isArray(scopes) && scopes.length ? scopes.join(' ') : null;

            if (existing.length > 0) {
                await db.update(systemConnections)
                    .set({
                        accessToken: encryptedToken,
                        externalUserId: handle || null,
                        scopes: scopeString,
                        metadata: pageUrl ? { pageUrl } : null,
                        status: 'active',
                        isActive: true,
                        updatedAt: new Date(),
                    })
                    .where(eq(systemConnections.id, existing[0].id));
            } else {
                await db.insert(systemConnections).values({
                    userId: currentUserId,
                    serviceName,
                    connectionType,
                    accessToken: encryptedToken,
                    externalUserId: handle || null,
                    scopes: scopeString,
                    metadata: pageUrl ? { pageUrl } : null,
                    status: 'active',
                    isActive: true,
                });
            }

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // --- DELETE: SECURE DATA PURGE ---
        if (event.httpMethod === 'DELETE') {
            const connectionId = event.queryStringParameters?.id;
            if (!connectionId) return { statusCode: 400, body: JSON.stringify({ error: 'Connection ID required.' }) };

            // Hard delete ensures tokens are permanently removed from the database
            await db.delete(systemConnections)
                .where(and(
                    eq(systemConnections.id, parseInt(connectionId)),
                    eq(systemConnections.userId, currentUserId)
                ));

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };
    } catch (error) {
        console.error('Integrations API Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};