// src/utils/active-assistant.ts
// Shared "does this org have an active assistant?" gate.
//
// Mirrors the Review Queue's client-side filter (workspace.html gpPopulateAssistants):
// an assistant counts as active when it is past provisioning (not 'pending'/'failed')
// and has not been archived. Used to gate work that an assistant is meant to drive —
// e.g. generating a social post, or generating AI media in My Content — so those flows
// don't dead-end with no one to action the result.

import { and, eq, ne, sql } from 'drizzle-orm';
import { withTenant } from '../../db/client';
import { aiAssistants } from '../../db/schema';

export async function hasActiveAssistant(orgId: number): Promise<boolean> {
    const rows = await withTenant(orgId, (tx) => tx
        .select({ id: aiAssistants.id })
        .from(aiAssistants)
        .where(and(
            eq(aiAssistants.organisationId, orgId),
            ne(aiAssistants.lifecycleStatus, 'archived'),
            // provisioning_status may be NULL on legacy rows — treat NULL as active to
            // match the client filter (`status !== 'pending' && status !== 'failed'`).
            sql`(${aiAssistants.provisioningStatus} IS NULL OR ${aiAssistants.provisioningStatus} NOT IN ('pending', 'failed'))`,
        ))
        .limit(1));
    return rows.length > 0;
}

// Standard 403 payload for the no-active-assistant gate. The `code` lets the client
// distinguish this from other 403s (e.g. the video tier-lock) and surface the right notice.
export const NO_ACTIVE_ASSISTANT_RESPONSE = {
    statusCode: 403,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        error: 'You need an active assistant to generate media. Hire one from the catalogue first.',
        code: 'no_active_assistant',
    }),
};
