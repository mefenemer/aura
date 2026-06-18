// netlify/functions/get-onboarding-progress.ts
// US1.1 — Dynamic onboarding progress widget. Returns the 3 setup steps with
// done-flags derived from real rows (AC1.1.2: a step auto-checks once its row
// exists — brand asset / connection / assistant). When all 3 are done, flips the
// permanent onboarding_completed flag so the widget never renders again (AC1.1.3).

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations, workspaceAssets, systemConnections, aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    const [org] = await db.select({ onboardingCompleted: organisations.onboardingCompleted })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1);

    // Already finished — widget must never render again.
    if (org?.onboardingCompleted) {
        return json(200, { onboardingCompleted: true, allDone: true, justCompleted: false, steps: [] });
    }

    const exists = async (rows: Promise<{ id: number | string }[]>) => (await rows).length > 0;
    const [brandVoice, connection, firstAssistant] = await Promise.all([
        exists(db.select({ id: workspaceAssets.id }).from(workspaceAssets).where(eq(workspaceAssets.organisationId, orgId)).limit(1)),
        exists(db.select({ id: systemConnections.id }).from(systemConnections).where(eq(systemConnections.organisationId, orgId)).limit(1)),
        exists(db.select({ id: aiAssistants.id }).from(aiAssistants).where(eq(aiAssistants.organisationId, orgId)).limit(1)),
    ]);

    // AC1.1.1: the three core steps.
    const steps = [
        { key: 'brand_voice',     label: 'Set Brand Voice',                    done: brandVoice },
        { key: 'connection',      label: 'Connect a CRM/Export Destination',   done: connection },
        { key: 'first_assistant', label: 'Hire Your First Assistant',          done: firstAssistant },
    ];
    const allDone = steps.every(s => s.done);

    let justCompleted = false;
    if (allDone) {
        await db.update(organisations).set({ onboardingCompleted: true }).where(eq(organisations.id, orgId));
        justCompleted = true; // AC1.1.3 — UI fires the celebration
    }

    return json(200, { onboardingCompleted: allDone, allDone, justCompleted, steps });
};
