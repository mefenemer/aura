// get-assistant-readiness.ts
// GET ?id=<assistantId>
// Returns the Kick Off Meeting readiness checklist for a specific assistant — the items
// the user confirms before the assistant starts working (Board Room). Each item's done-flag
// is derived from real rows; `allRequiredDone` gates the Kick Off action in the UI.

import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb, withTenant } from '../../db/client';
import { aiAssistants, systemConnections, contentRules } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const idParam = event.queryStringParameters?.id;
    const assistantId = idParam ? parseInt(idParam, 10) : NaN;
    if (!assistantId || Number.isNaN(assistantId)) {
        return json(400, { error: 'id parameter is required.' });
    }

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    try {
        const result = await withTenant(orgId, async (tx) => {
            // ── IDOR guard: assistant must belong to the caller's organisation ──
            const [assistant] = await tx.select({
                id: aiAssistants.id,
                name: aiAssistants.name,
                role: aiAssistants.aiAssistantJobRole,
                isActive: aiAssistants.isActive,
                provisioningStatus: aiAssistants.provisioningStatus,
                lifecycleStatus: aiAssistants.lifecycleStatus,
                configuration: aiAssistants.configuration,
                onboardingContext: aiAssistants.onboardingContext,
                disclosureText: aiAssistants.disclosureText,
                prohibitedUseAcknowledged: aiAssistants.prohibitedUseAcknowledged,
                updatedAt: aiAssistants.updatedAt,
            }).from(aiAssistants)
              .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
              .limit(1);
            if (!assistant) return null;

            const exists = async (rows: Promise<{ id: number }[]>) => (await rows).length > 0;
            const [hasConnection, hasRule] = await Promise.all([
                // ≥1 active connection for this assistant, else any org-level connection.
                exists(tx.select({ id: systemConnections.id }).from(systemConnections).where(and(
                    eq(systemConnections.organisationId, orgId),
                    eq(systemConnections.isActive, true),
                )).limit(1)),
                // ≥1 guardrail/rule configured for this assistant.
                exists(tx.select({ id: contentRules.id }).from(contentRules).where(and(
                    eq(contentRules.assistantId, assistantId),
                    eq(contentRules.isActive, true),
                )).limit(1)),
            ]);
            // US3 AC3.1: active connection service names for the Kick-Off summary screen.
            const connRows = await tx.select({ serviceName: systemConnections.serviceName })
                .from(systemConnections)
                .where(and(eq(systemConnections.organisationId, orgId), eq(systemConnections.isActive, true)));
            const connections = connRows.map(r => r.serviceName).filter(Boolean);
            return { assistant, hasConnection, hasRule, connections };
        });

        if (!result) return json(404, { error: 'Assistant not found.' });
        const { assistant, hasConnection, hasRule, connections } = result;

        // Brand & strategy is configured once the onboarding context / configuration is populated.
        const oc = (assistant.onboardingContext as Record<string, unknown> | null) || {};
        const cfg = (assistant.configuration as Record<string, unknown> | null) || {};
        const brandConfigured = Object.keys(oc).length > 0 || Object.keys(cfg).length > 0;
        const disclosureDone = Boolean(assistant.disclosureText?.trim());

        // required: must pass before the assistant can be kicked off (the disclosure item is
        // also enforced server-side by manage-assistant's resume guard — EU AI Act Art. 52).
        const items = [
            { key: 'brand_strategy', label: 'Brand & strategy configured', done: brandConfigured, required: true,
              hint: 'Complete the onboarding form so your assistant knows your brand and goals.' },
            { key: 'connections', label: 'Tools connected', done: hasConnection, required: true,
              hint: 'Connect at least one account so your assistant can do its work.' },
            { key: 'disclosure', label: 'AI disclosure acknowledged', done: disclosureDone, required: true,
              hint: 'Add the AI disclosure text (required by EU AI Act Art. 52) before activation.' },
            { key: 'guardrails', label: 'Guardrails & rules set', done: hasRule, required: false,
              hint: 'Add at least one rule to steer tone and content (recommended).' },
        ];

        const allRequiredDone = items.filter(i => i.required).every(i => i.done);

        return json(200, {
            assistantId,
            status: assistant.provisioningStatus,
            isActive: assistant.isActive,
            lifecycleStatus: assistant.lifecycleStatus,
            // "working" once the assistant is provisioned and active.
            working: assistant.isActive && assistant.provisioningStatus === 'complete',
            workingSince: assistant.updatedAt,
            // US3 AC3.1: Kick-Off summary — what the user reviews before confirming.
            summary: {
                name: assistant.name,
                directive: assistant.role || 'Digital Assistant',
                connections,
            },
            items,
            allRequiredDone,
        });

    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        // Table not yet migrated — degrade gracefully rather than 500.
        if (msg.includes('relation') && msg.includes('does not exist')) {
            return json(200, { assistantId, items: [], allRequiredDone: false, working: false });
        }
        console.error('[get-assistant-readiness]', err);
        return json(500, { error: 'Failed to load readiness.' });
    }
};
