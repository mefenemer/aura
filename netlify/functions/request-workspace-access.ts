// request-workspace-access.ts — Abuse Prevention US2 (AC2.2).
// POST { platform }  (authenticated)
//
// When a user hit a tenant-collision (US1) trying to connect a third-party account that's already
// linked to another workspace, this lets them ASK to join that workspace. It looks up the most
// recent pending collision attempt for the caller's org + platform, then notifies the EXISTING
// workspace's owner (in-app suggested_action + email) so they can invite the requester — keeping
// billing consolidated. The caller never learns who owns the existing workspace (AC2.1).

import { Handler } from '@netlify/functions';
import { and, eq, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { connectionCollisionAttempts, userOrganisations, users, notifications } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { sendEmail } from '../../src/utils/email';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const LABELS: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X (Twitter)' };

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    const platform = String(JSON.parse(event.body || '{}').platform || '').toLowerCase();
    if (!platform) return json(400, { error: 'platform is required.' });

    // Most recent pending collision for this org + platform.
    const [attempt] = await db.select().from(connectionCollisionAttempts)
        .where(and(
            eq(connectionCollisionAttempts.requestingOrgId, orgId),
            eq(connectionCollisionAttempts.serviceName, platform),
            eq(connectionCollisionAttempts.status, 'pending'),
        ))
        .orderBy(desc(connectionCollisionAttempts.createdAt))
        .limit(1);

    // Generic response either way so timing/availability never reveals the other workspace.
    if (!attempt) return json(200, { ok: true });

    // Requester identity (shared only with the existing workspace's admin, never the reverse).
    const [requester] = await db.select({ email: users.email, firstName: users.firstName })
        .from(users).where(eq(users.id, userId)).limit(1);

    // The existing workspace's owner is the recipient.
    const [owner] = await db.select({ userId: userOrganisations.userId, email: users.email, firstName: users.firstName })
        .from(userOrganisations)
        .innerJoin(users, eq(users.id, userOrganisations.userId))
        .where(and(eq(userOrganisations.organisationId, attempt.existingOrgId), eq(userOrganisations.role, 'owner')))
        .limit(1);

    const label = LABELS[platform] || platform;

    if (owner && requester) {
        await db.insert(notifications).values({
            userId: owner.userId,
            type: 'workspace_access_request',
            category: 'suggested_action',
            title: 'Connection access request',
            message: `Someone (${requester.email}) is trying to connect your ${label} account to Be More Swan. Invite them to your team?`,
            metadata: { requestingEmail: requester.email, serviceName: platform },
        });

        await sendEmail({
            to: owner.email,
            subject: `Someone wants to connect your ${label} account`,
            html: `<p>Hi ${owner.firstName || 'there'},</p>
                   <p><strong>${requester.email}</strong> tried to connect your ${label} account to Be More Swan, but it's already linked to your workspace.</p>
                   <p>If this is a colleague, invite them to your workspace so you share one account and billing stays consolidated. Log in and open your notifications to invite them with one click.</p>
                   <p>If you don't recognise this person, you can safely ignore this email.</p>`,
        }).catch(() => {/* non-blocking */});
    }

    await db.update(connectionCollisionAttempts)
        .set({ status: 'requested', updatedAt: new Date() })
        .where(eq(connectionCollisionAttempts.id, attempt.id));

    return json(200, { ok: true });
};
