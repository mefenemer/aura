// notification-preferences.ts
// GET  → returns the user's current email notification preferences
// POST → instant-save a single preference toggle (or a full object)
//
// GET response:
//   { preferences: Record<string, boolean>, categories: CategoryMeta[] }
//
// POST body:
//   { key: string, value: boolean }   — single toggle
//   { preferences: Record<string,boolean> }  — full replace (for bulk update)
//
// POST response:
//   { success: true, preferences: Record<string,boolean> }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { userProfiles } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

// ── Category definitions (source of truth) ───────────────────────────────────
// locked: true  → always enabled; toggle is visible but disabled
// defaultValue  → used when the user has no stored preference
export const EMAIL_CATEGORIES = [
    {
        key: 'payment_confirmation',
        label: 'Payment Confirmations',
        description: 'Receipts and payment status for every transaction.',
        locked: true,
        defaultValue: true,
    },
    {
        key: 'account_creation',
        label: 'Account & Security Alerts',
        description: 'Verification emails, password changes, and new login notices.',
        locked: true,
        defaultValue: true,
    },
    {
        key: 'account_cancellation',
        label: 'Subscription Changes',
        description: 'Notifications when your plan is changed, upgraded, or cancelled.',
        locked: true,
        defaultValue: true,
    },
    {
        key: 'invoice_ready',
        label: 'Invoice Ready',
        description: 'Email alert when a new invoice is available to download.',
        locked: false,
        defaultValue: true,
    },
    {
        key: 'assistant_tasks',
        label: 'Assistant Tasks & Summaries',
        description: 'Daily or on-demand reports from your active AI assistants.',
        locked: false,
        defaultValue: true,
    },
    {
        key: 'content_calendar',
        label: 'Content Calendar Updates',
        description: 'Approval reminders, post status changes, and publishing confirmations.',
        locked: false,
        defaultValue: true,
    },
    {
        key: 'onboarding_reminders',
        label: 'Onboarding Reminders',
        description: 'Nudges to complete your assistant setup if you step away mid-onboarding.',
        locked: false,
        defaultValue: true,
    },
    {
        key: 'new_role_availability',
        label: 'New Role Availability',
        description: 'Emails when a new assistant role you've joined the waitlist for becomes live.',
        locked: false,
        defaultValue: false,
    },
] as const;

// Build defaults object for new / incomplete profiles
export function buildDefaultPreferences(): Record<string, boolean> {
    return Object.fromEntries(EMAIL_CATEGORIES.map(c => [c.key, c.defaultValue]));
}

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return null;
    try { return (jwt.verify(cookie, jwtSecret) as { userId: number }).userId; } catch { return null; }
}

export const handler: Handler = async (event) => {
    if (!['GET', 'POST'].includes(event.httpMethod)) {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const userId = getAuth(event);
    if (!userId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    // ── GET ────────────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const [profile] = await db
            .select({ emailPreferences: userProfiles.emailPreferences })
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .limit(1);

        const stored = (profile?.emailPreferences as Record<string, boolean> | null) || {};
        const defaults = buildDefaultPreferences();

        // Merge: stored values win; fall back to defaults for missing keys;
        // locked keys are always forced to true regardless of stored value
        const preferences: Record<string, boolean> = { ...defaults, ...stored };
        for (const cat of EMAIL_CATEGORIES) {
            if (cat.locked) preferences[cat.key] = true;
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                preferences,
                categories: EMAIL_CATEGORIES,
            }),
        };
    }

    // ── POST ───────────────────────────────────────────────────────────────────
    let body: { key?: string; value?: boolean; preferences?: Record<string, boolean> } = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    // Load existing profile to get current preferences
    const [profile] = await db
        .select({ id: userProfiles.id, emailPreferences: userProfiles.emailPreferences })
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId))
        .limit(1);

    if (!profile) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Profile not found.' }) };
    }

    const current = (profile.emailPreferences as Record<string, boolean> | null) || buildDefaultPreferences();

    let updated: Record<string, boolean>;

    if (body.preferences && typeof body.preferences === 'object') {
        // Bulk replace — validate all keys
        updated = { ...current };
        for (const [k, v] of Object.entries(body.preferences)) {
            if (typeof v !== 'boolean') continue;
            const cat = EMAIL_CATEGORIES.find(c => c.key === k);
            if (!cat) continue;           // unknown key — skip
            if (cat.locked) continue;     // locked — ignore attempt to change
            updated[k] = v;
        }
    } else if (body.key !== undefined && body.value !== undefined) {
        // Single toggle
        const cat = EMAIL_CATEGORIES.find(c => c.key === body.key);
        if (!cat) {
            return { statusCode: 400, body: JSON.stringify({ error: `Unknown preference key: ${body.key}` }) };
        }
        if (cat.locked) {
            return { statusCode: 400, body: JSON.stringify({ error: `Cannot change locked preference: ${body.key}` }) };
        }
        updated = { ...current, [body.key]: !!body.value };
    } else {
        return { statusCode: 400, body: JSON.stringify({ error: 'Provide either { key, value } or { preferences }.' }) };
    }

    // Enforce locked keys are always true in stored object
    for (const cat of EMAIL_CATEGORIES) {
        if (cat.locked) updated[cat.key] = true;
    }

    await db
        .update(userProfiles)
        .set({ emailPreferences: updated, updatedAt: new Date() })
        .where(eq(userProfiles.userId, userId));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, preferences: updated }),
    };
};
