// src/utils/issue-reports.ts
// Shared constants/helpers for the testing-phase "Report an Issue" feature.

import { eq, or } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { users } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

// Canonical lifecycle states. KEEP IN SYNC with db/issue-reports.sql status CHECK.
export const ISSUE_STATUSES = [
    'reported',
    'fix_in_progress',
    'fixed_ready_to_test',
    'more_info_required',
    'closed',
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export function isIssueStatus(v: unknown): v is IssueStatus {
    return typeof v === 'string' && (ISSUE_STATUSES as readonly string[]).includes(v);
}

// Human-readable labels — match the wording the admin owner sees in the portal.
export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
    reported: 'Reported',
    fix_in_progress: 'Fix In Progress',
    fixed_ready_to_test: 'Fixed & Ready to Test',
    more_info_required: 'More Info Required',
    closed: 'Closed',
};

// Screenshots are stored inline as base64 data URLs. Cap the decoded payload so a stray
// huge upload can't blow up the row / the admin notification email.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

export const ALLOWED_IMAGE_MIME = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

/**
 * Validate an inbound `data:` image URL. Returns the mime type on success or an error
 * string. Keeps the function handlers thin and the rules in one place.
 */
export function validateImageDataUrl(dataUrl: string): { mime: string } | { error: string } {
    const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
    if (!m) return { error: 'Image must be a base64 data URL.' };
    const mime = m[1].toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mime)) return { error: `Unsupported image type: ${mime}` };
    // base64 length → decoded byte estimate.
    const approxBytes = Math.floor((m[2].length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) return { error: 'Image exceeds the 5 MB limit.' };
    return { mime };
}

export interface AdminRecipient { id: number; email: string; firstName: string | null }

/**
 * The "admin portal owner(s)" to email when a new issue is recorded. Prefers the
 * ISSUE_REPORT_NOTIFY_EMAIL env override; otherwise every super_admin / admin account.
 */
export async function getAdminRecipients(db: Db): Promise<AdminRecipient[]> {
    const override = process.env.ISSUE_REPORT_NOTIFY_EMAIL;
    if (override) {
        return override.split(',').map((e, i) => ({ id: -1 - i, email: e.trim(), firstName: null })).filter((r) => r.email);
    }
    const rows = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName })
        .from(users)
        .where(or(eq(users.role, 'super_admin'), eq(users.role, 'admin')));
    return rows;
}
