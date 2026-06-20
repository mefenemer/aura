// netlify/functions/get-onboarding-progress.ts
// US1.1 — Dynamic onboarding progress widget. Returns the 3 setup steps with
// done-flags derived from real rows (AC1.1.2: a step auto-checks once its row
// exists — brand asset / connection / assistant). When all 3 are done, flips the
// permanent onboarding_completed flag so the widget never renders again (AC1.1.3).

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations, systemConnections, aiAssistants, notifications } from '../../db/schema';
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

    const [org] = await db.select({
        onboardingCompleted: organisations.onboardingCompleted,
        industry:            organisations.industry,
        businessDescription: organisations.businessDescription,
        targetAudience:      organisations.targetAudience,
    }).from(organisations).where(eq(organisations.id, orgId)).limit(1);

    // Already finished — widget must never render again.
    if (org?.onboardingCompleted) {
        return json(200, { onboardingCompleted: true, allDone: true, justCompleted: false, steps: [] });
    }

    // Step 1 ticks once the core business-profile fields are filled in (Business
    // Information page). The other two auto-check once a row exists.
    const businessProfile = Boolean(org?.industry && org?.businessDescription && org?.targetAudience);

    const exists = async (rows: Promise<{ id: number | string }[]>) => (await rows).length > 0;
    const [connection, firstAssistant] = await Promise.all([
        exists(db.select({ id: systemConnections.id }).from(systemConnections).where(eq(systemConnections.organisationId, orgId)).limit(1)),
        exists(db.select({ id: aiAssistants.id }).from(aiAssistants).where(eq(aiAssistants.organisationId, orgId)).limit(1)),
    ]);

    // AC1.1.1: the three core steps. Labels mirror the welcome email
    // (verify.ts) so the in-app checklist reads identically to what users receive.
    const steps = [
        { key: 'business_profile', label: 'Complete your business profile', done: businessProfile },
        { key: 'first_assistant',  label: 'Choose your assistant',          done: firstAssistant },
        { key: 'connection',       label: 'Connect your tools',             done: connection },
    ];
    const allDone = steps.every(s => s.done);

    let justCompleted = false;
    if (allDone) {
        // Atomic flip: only the request that actually transitions the flag (false→true)
        // runs the one-time side effects below, so concurrent calls can't double-fire.
        const flipped = await db.update(organisations)
            .set({ onboardingCompleted: true })
            .where(and(eq(organisations.id, orgId), eq(organisations.onboardingCompleted, false)))
            .returning({ id: organisations.id });
        if (flipped.length) {
            justCompleted = true; // AC1.1.3 — UI fires the celebration
            // Replace the onboarding prompts with a single "Setup complete" notification.
            try {
                await db.delete(notifications).where(and(
                    eq(notifications.userId, ctx.userId),
                    inArray(notifications.type, ['welcome', 'onboarding_prompt']),
                ));
                await db.insert(notifications).values({
                    userId: ctx.userId,
                    type: 'setup_complete',
                    title: 'Setup complete 🎉',
                    message: 'Your business profile and assistant are ready — your assistant is now working for you.',
                });
            } catch (notifErr) {
                console.warn('[get-onboarding-progress] setup-complete notification swap failed (non-blocking):', notifErr);
            }
        }
    }

    return json(200, { onboardingCompleted: allDone, allDone, justCompleted, steps });
};
