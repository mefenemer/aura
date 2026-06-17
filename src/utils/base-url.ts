// src/utils/base-url.ts
// Resolve the app origin used to build server-side links and redirects.
//
// Order of preference:
//   1. BASE_URL env var          — the explicit, trusted value (always set this in Production).
//   2. DEPLOY_PRIME_URL env var  — Netlify-provided per-deploy URL (correct on deploy previews).
//   3. The request's own host    — last-resort fallback so links point back to the same deployment.
//
// Returns null only when none are available (e.g. a background/cron invocation with no request and
// no env configured) — callers should treat that as a misconfiguration and fail cleanly.

type RequestHeaders = Record<string, string | undefined>;

export function resolveBaseUrl(headers?: RequestHeaders): string | null {
    if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
    if (process.env.DEPLOY_PRIME_URL) return process.env.DEPLOY_PRIME_URL.replace(/\/$/, '');
    if (headers) {
        const host  = headers['x-forwarded-host'] || headers['host'];
        const proto = headers['x-forwarded-proto'] || 'https';
        if (host) return `${proto}://${host}`;
    }
    return null;
}
