import { Context } from "@netlify/edge-functions";

export default async (request: Request, context: Context) => {
    const url = new URL(request.url);

    // Skip non-HTML paths (assets, functions, etc.)
    if (!url.pathname.endsWith('.html') && url.pathname !== '/') {
        return context.next();
    }

    // Always allow access to maintenance, login, and static pages
    const ALWAYS_ALLOWED = ['/maintenance.html', '/login.html', '/logout.html', '/check-email.html', '/register.html'];
    if (ALWAYS_ALLOWED.includes(url.pathname)) {
        return context.next();
    }

    // ── US-ADM-3.2.1: Maintenance mode check ─────────────────────────────────
    // Fetch the lightweight config endpoint. Fails open (returns context.next())
    // if the config service is unreachable, to avoid taking down the whole platform.
    try {
        const configUrl = `${url.origin}/.netlify/functions/platform-config-public`;
        const configRes = await fetch(configUrl, { signal: AbortSignal.timeout(2000) });
        if (configRes.ok) {
            const cfg = await configRes.json() as {
                maintenanceMode: boolean;
                maintenanceMessage: string;
                registrationLocked: boolean;
                globalAiDisabled: boolean;
            };

            if (cfg.maintenanceMode) {
                // Admin users (identified by aura_session cookie with adminRole) bypass maintenance
                const sessionCookie = context.cookies.get('aura_session');
                let isAdmin = false;
                if (sessionCookie) {
                    try {
                        const parts = sessionCookie.split('.');
                        if (parts.length === 3) {
                            const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
                            const ADMIN_ROLES = ['admin', 'super_admin', 'platform_admin', 'billing_admin', 'support_agent'];
                            isAdmin = !!(payload.adminRole && ADMIN_ROLES.includes(payload.adminRole));
                        }
                    } catch { /* ignore — non-admin */ }
                }

                if (!isAdmin) {
                    // Redirect to maintenance page, passing the message as a query param
                    const maintenanceUrl = new URL('/maintenance.html', request.url);
                    maintenanceUrl.searchParams.set('msg', cfg.maintenanceMessage);
                    return Response.redirect(maintenanceUrl.toString(), 302);
                }
            }

            // US-ADM-3.2.1: Global AI kill switch — non-admin users on workspace see banner via JS;
            // the individual AI function handlers return 503 (fixes in get-assistant-context.ts,
            // provision-assistant-async.ts). No page-level redirect needed here.

            // Block registration if new_registration_lock is active
            if (cfg.registrationLocked && url.pathname === '/register.html') {
                return Response.redirect(new URL('/login.html?locked=1', request.url), 302);
            }
        }
    } catch (err) {
        // Config check failed — fail open and let the request proceed
        console.warn('[auth-guard] Platform config check failed (fail open):', err);
    }

    // ── Session guard — protected pages require a valid aura_session cookie ────
    const protectedPaths = [
        '/workspace.html',
        '/onboarding.html',
        '/dashboard.html',
        '/billing.html',
        '/admin.html',
    ];

    if (protectedPaths.includes(url.pathname)) {
        const sessionCookie = context.cookies.get("aura_session");
        if (!sessionCookie) {
            console.log(`[auth-guard] Blocked unauthorized access to ${url.pathname}`);
            return Response.redirect(new URL('/login.html', request.url));
        }

        // US-ADM-1.3.2: Check JWT blocklist — reject erased/revoked user sessions immediately
        try {
            const parts = sessionCookie.split('.');
            if (parts.length === 3) {
                const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
                if (payload.userId) {
                    const revokeCheckUrl = `${url.origin}/.netlify/functions/check-token-revoked?userId=${payload.userId}`;
                    const revokeRes = await fetch(revokeCheckUrl, { signal: AbortSignal.timeout(1500) });
                    if (revokeRes.ok) {
                        const { revoked } = await revokeRes.json() as { revoked: boolean };
                        if (revoked) {
                            console.log(`[auth-guard] Blocked revoked session for userId=${payload.userId}`);
                            const logoutUrl = new URL('/login.html', request.url);
                            logoutUrl.searchParams.set('error', 'session_revoked');
                            const response = Response.redirect(logoutUrl.toString(), 302);
                            // Clear the stale cookie
                            response.headers.append('Set-Cookie', 'aura_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax');
                            return response;
                        }
                    }
                }
            }
        } catch {
            // Blocklist check failed — fail open so a DB outage doesn't lock out all users
        }
    }

    return context.next();
};
