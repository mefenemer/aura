// netlify/functions/get-wizard-state.ts
// Single source of truth for the Frictionless Onboarding Wizard — the persistent
// right-hand slide-over companion checklist. Composes the 9-step journey with live
// `done` flags derived from real rows (a step auto-checks once its backing data exists),
// the index of the next incomplete step (resume focus, US2 AC5), and an aggregate
// completion + dismissed signal that drives auto-open / go-live behaviour.
//
// The drawer owns NO form data — each step deep-links to the real page, whose existing
// auto-save persists the input. This endpoint only reports aggregate state. Read-only.

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    organisations, userProfiles, plans, systemConnections, aiAssistants, onboardingDrafts,
} from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// Each step's stable key, label, the workspace view its action button routes to, and the
// contextual "why" benefit shown beneath it (US2 AC1). `view` may be null for the terminal
// go-live step (no action — it celebrates automatically).
const STEP_DEFS: { key: string; label: string; view: string | null; benefit: string }[] = [
    { key: 'plan',                 label: 'Choose your plan',            view: 'billing',  benefit: 'Pick the plan that fits and activate your account to unlock your digital team.' },
    { key: 'business_info',        label: 'Business information',        view: 'assets',   benefit: 'Tell us about your business so your assistant matches your brand, industry and audience.' },
    { key: 'profile',              label: 'Your profile',                view: 'settings', benefit: 'Set your working hours and timezone so your assistant works to your schedule.' },
    { key: 'system_config',        label: 'Connect your tools',          view: 'catalog',  benefit: 'Securely connect the apps your assistant needs — you stay in control of every permission.' },
    { key: 'compliance',           label: 'Compliance & data use',       view: 'settings', benefit: 'Review our plain-language AI and data-processing terms to keep your company data safe.' },
    { key: 'assistant_selection',  label: 'Choose your assistant',       view: 'catalog',  benefit: 'Pick the assistant persona that matches the work you want done for you.' },
    { key: 'assistant_onboarding', label: 'Onboard your assistant',      view: 'assistants', benefit: 'Give your assistant the context it needs — your goals, brand voice and guardrails.' },
    { key: 'kick_off',             label: 'Kick-off meeting',            view: 'assistants', benefit: 'Run the Board Room readiness check and put your assistant to work.' },
    { key: 'go_live',              label: 'Your assistant goes live',    view: null,         benefit: "The finish line — your assistant is live and working for you." },
];

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;
    const userId = ctx.userId;

    const [org] = await db.select({
        onboardingCompleted:  organisations.onboardingCompleted,
        complianceAcceptedAt: organisations.complianceAcceptedAt,
        industry:             organisations.industry,
        businessDescription:  organisations.businessDescription,
        targetAudience:       organisations.targetAudience,
    }).from(organisations).where(eq(organisations.id, orgId)).limit(1);

    const [profile] = await db.select({ workingHours: userProfiles.workingHours })
        .from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);

    // ── Secondary-onboarding scoping (US8 AC3) ──────────────────────────────
    // When a user adds another assistant, steps 6-9 must track only THAT new assistant,
    // not the org's existing live ones. The client passes mode=new plus a monotonic
    // baseline (the max assistant/draft id captured the moment "Add New Assistant" was
    // clicked); we then consider only entities created past that baseline. Ids survive
    // the full-page hop to the standalone onboarding wizard (carried in sessionStorage),
    // and being monotonic they're immune to client clock skew.
    const qs = event.queryStringParameters || {};
    const isNewMode = qs.mode === 'new';
    const sinceAssistantId = isNewMode ? Number(qs.sinceAssistantId || 0) : 0;
    const sinceDraftId     = isNewMode ? Number(qs.sinceDraftId || 0) : 0;

    const exists = async (rows: Promise<{ id: number | string }[]>) => (await rows).length > 0;
    const [planActive, connection, assistantRows, draftRows] = await Promise.all([
        // Step 1 — an active (or grace-period past_due) subscription exists for the org.
        exists(db.select({ id: plans.id }).from(plans).where(and(
            eq(plans.organisationId, orgId), inArray(plans.status, ['active', 'past_due']),
        )).limit(1)),
        // Step 4 — at least one system connection has been made.
        exists(db.select({ id: systemConnections.id }).from(systemConnections)
            .where(eq(systemConnections.organisationId, orgId)).limit(1)),
        // Org assistants — few per org, so fetch the columns we need and reason in JS. This
        // lets the same rows drive both the org-global (primary) and id-scoped (new) views.
        db.select({ id: aiAssistants.id, provisioningStatus: aiAssistants.provisioningStatus, isActive: aiAssistants.isActive })
            .from(aiAssistants).where(eq(aiAssistants.organisationId, orgId)),
        // Open onboarding drafts (one exists only while an assistant wizard is in progress).
        db.select({ id: onboardingDrafts.id }).from(onboardingDrafts)
            .where(eq(onboardingDrafts.organisationId, orgId)),
    ]);

    // Latest ids — returned so the client can baseline the next "add assistant" journey.
    const maxAssistantId = assistantRows.reduce((m, a) => Math.max(m, Number(a.id)), 0);
    const maxDraftId     = draftRows.reduce((m, d) => Math.max(m, Number(d.id)), 0);

    // Scope the assistant/draft sets: in new-mode, only entities past the baseline count.
    const scopedAssistants = isNewMode ? assistantRows.filter(a => Number(a.id) > sinceAssistantId) : assistantRows;
    const scopedDrafts      = isNewMode ? draftRows.filter(d => Number(d.id) > sinceDraftId)        : draftRows;

    const anyAssistant    = scopedAssistants.length > 0;
    const draftInProgress = scopedDrafts.length > 0;
    // Step 8 (kick-off reached) — provisioning has completed → assistant is ready_for_work or
    // beyond. Step 9 (live) — provisioning complete AND active (the kick-off flipped it to
    // 'working'/isActive). ready_for_work has isActive=false, so 8 ticks before 9, giving a
    // real 7→8→9 progression instead of isActive (which defaults true on creation).
    const provisioned = scopedAssistants.some(a => a.provisioningStatus === 'complete');
    const live        = scopedAssistants.some(a => a.provisioningStatus === 'complete' && a.isActive === true);

    // Business profile is "done" on the same signal the legacy widget uses (industry +
    // description + audience) so the two stay consistent.
    const businessProfile = Boolean(org?.industry && org?.businessDescription && org?.targetAudience);

    const doneByKey: Record<string, boolean> = {
        plan:                 planActive,
        business_info:        businessProfile,
        profile:              profile?.workingHours != null,
        system_config:        connection,
        compliance:           org?.complianceAcceptedAt != null,
        // Selecting a role = an assistant row OR a draft has been started.
        assistant_selection:  anyAssistant || draftInProgress,
        // Onboarding form finished = assistant exists and no draft is still open.
        assistant_onboarding: anyAssistant && !draftInProgress,
        kick_off:             provisioned,
        go_live:              live,
    };

    const steps = STEP_DEFS.map(d => ({ ...d, done: doneByKey[d.key] === true }));
    const allDone = steps.every(s => s.done);
    // 1-based number of the first incomplete step (resume focus, US2 AC5); steps.length+1
    // when everything is done.
    const firstIncomplete = steps.findIndex(s => !s.done);
    const currentStep = firstIncomplete === -1 ? steps.length + 1 : firstIncomplete + 1;

    return json(200, {
        steps,
        currentStep,
        allDone,
        completedCount: steps.filter(s => s.done).length,
        total: steps.length,
        // Once the legacy onboarding flag is set the wizard no longer auto-opens (US8 AC2):
        // the user can still re-open it manually from My Account. A secondary-onboarding
        // journey is never "dismissed" — it should surface until the new assistant is live.
        dismissed: isNewMode ? false : (org?.onboardingCompleted === true),
        // Baseline anchors for the next "add assistant" journey (US8 AC3).
        maxAssistantId,
        maxDraftId,
    });
};
