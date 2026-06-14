// netlify/functions/assemble-blueprint.ts
// US-ADM-4.2.1: Blueprint Assembly Engine
//
// GET  /.netlify/functions/assemble-blueprint?assistantId=N[&force=1]
//   Returns (or reuses cached) compiled blueprint JSON for the given assistant.
//   force=1 recompiles even if a current-version cache exists.
//
// POST /.netlify/functions/assemble-blueprint?assistantId=N&action=send
//   Marks the latest blueprint as sent (records sentAt + sentByAdminId).
//
// Auth: aura_session with adminRole required.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    users,
    aiAssistants,
    masterAssistants,
    assistantVersions,
    contentRules,
    organisations,
    userProfiles,
    systemConnections,
    plans,
    masterPlans,
    usageCounters,
    featureFlags,
    dpaAcceptances,
    aiBlueprints,
    integrationAuthorizations,
} from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;
const ADMIN_ROLES = ['admin', 'super_admin', 'platform_admin', 'billing_admin', 'support_agent'];

// ── Types ────────────────────────────────────────────────────────────────────

interface SourceRef {
    table: string;
    column: string;
    recordId: number | string | null;
    resolvedAt?: string | null;
}

interface MissingField {
    section: string;
    field: string;
    sourceTable: string;
    sourceColumn: string;
    severity: 'blocking' | 'warning';
}

interface SectionResult {
    status: 'complete' | 'partial' | 'missing';
    content: Record<string, unknown>;
    sources: SourceRef[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function src(table: string, column: string, recordId: number | string | null, updatedAt?: Date | string | null): SourceRef {
    return { table, column, recordId, resolvedAt: updatedAt ? new Date(updatedAt).toISOString() : null };
}

function sectionStatus(content: Record<string, unknown>, requiredKeys: string[]): 'complete' | 'partial' | 'missing' {
    const populated = requiredKeys.filter(k => content[k] != null && content[k] !== '');
    if (populated.length === 0) return 'missing';
    if (populated.length < requiredKeys.length) return 'partial';
    return 'complete';
}

function blueprintHash(parts: Array<{ id: number | string; updatedAt?: Date | string | null }>): string {
    const raw = parts.map(p => `${p.id}:${p.updatedAt ?? ''}`).join('|');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// ── Assembly ──────────────────────────────────────────────────────────────────

async function assembleBlueprint(assistantId: number, compiledBy: string, triggerType: string) {
    const db = getDb();
    const missing: MissingField[] = [];
    const sections: Record<string, SectionResult> = {};
    const hashParts: Array<{ id: number | string; updatedAt?: Date | string | null }> = [];

    // ── Load assistant row ────────────────────────────────────────────────────
    const [asst] = await db.select().from(aiAssistants).where(eq(aiAssistants.id, assistantId)).limit(1);
    if (!asst) throw new Error('Assistant not found');
    hashParts.push({ id: `asst:${asst.id}`, updatedAt: asst.updatedAt });

    // ── Section 1 — IDENTITY ──────────────────────────────────────────────────
    const [master] = asst.masterAssistantId
        ? await db.select().from(masterAssistants).where(eq(masterAssistants.id, asst.masterAssistantId)).limit(1)
        : [null];
    if (master) hashParts.push({ id: `master:${master.id}`, updatedAt: master.updatedAt });

    const s1content = {
        assistantName: asst.name,
        customName: asst.name,
        role: asst.aiAssistantJobRole ?? master?.name ?? null,
        category: master?.category ?? null,
        riskTier: master?.riskClassification ?? null,
    };
    if (!s1content.role) missing.push({ section: '1-identity', field: 'role', sourceTable: 'ai_assistants', sourceColumn: 'ai_assistant_job_role', severity: 'warning' });
    if (!s1content.riskTier) missing.push({ section: '1-identity', field: 'riskTier', sourceTable: 'master_assistants', sourceColumn: 'risk_classification', severity: 'warning' });
    sections['1-identity'] = {
        status: sectionStatus(s1content, ['assistantName', 'role', 'category', 'riskTier']),
        content: s1content,
        sources: [
            src('ai_assistants', 'name', asst.id, asst.updatedAt),
            src('ai_assistants', 'ai_assistant_job_role', asst.id, asst.updatedAt),
            ...(master ? [src('master_assistants', 'category', master.id, master.updatedAt), src('master_assistants', 'risk_classification', master.id, master.updatedAt)] : []),
        ],
    };

    // ── Section 2 — BASE SYSTEM PROMPT ───────────────────────────────────────
    let version: typeof assistantVersions.$inferSelect | null = null;
    if (master?.currentVersionId) {
        const [v] = await db.select().from(assistantVersions).where(eq(assistantVersions.id, master.currentVersionId)).limit(1);
        version = v ?? null;
        if (version) hashParts.push({ id: `version:${version.id}`, updatedAt: version.createdAt });
    }
    const s2content = {
        systemPrompt: asst.systemPrompt ?? version?.systemPrompt ?? null,
        versionNumber: version?.versionNumber ?? null,
        effectiveDate: version?.createdAt ?? null,
    };
    if (!s2content.systemPrompt) missing.push({ section: '2-base-prompt', field: 'systemPrompt', sourceTable: 'ai_assistants', sourceColumn: 'system_prompt', severity: 'blocking' });
    sections['2-base-prompt'] = {
        status: sectionStatus(s2content, ['systemPrompt']),
        content: s2content,
        sources: [
            src('ai_assistants', 'system_prompt', asst.id, asst.updatedAt),
            ...(version ? [src('assistant_versions', 'system_prompt', version.id, version.createdAt)] : []),
        ],
    };

    // ── Section 3 — STRICT RULES (onboarding-derived constraints) ────────────
    const onboardingCtx = (asst.onboardingContext ?? {}) as Record<string, unknown>;
    const s3content = {
        constraints: onboardingCtx.constraints ?? onboardingCtx.strict_rules ?? null,
        prohibitedUseAcknowledged: asst.prohibitedUseAcknowledged,
    };
    if (!asst.prohibitedUseAcknowledged) missing.push({ section: '3-strict-rules', field: 'prohibitedUseAcknowledged', sourceTable: 'ai_assistants', sourceColumn: 'prohibited_use_acknowledged', severity: 'blocking' });
    sections['3-strict-rules'] = {
        status: asst.prohibitedUseAcknowledged ? 'complete' : 'missing',
        content: s3content,
        sources: [src('ai_assistants', 'prohibited_use_acknowledged', asst.id, asst.updatedAt)],
    };

    // ── Section 4 — CONTENT RULES ─────────────────────────────────────────────
    const rules = await db.select().from(contentRules)
        .where(and(eq(contentRules.workspaceId, asst.organisationId), eq(contentRules.isActive, true)))
        .orderBy(contentRules.createdAt);
    const assistantRules = rules.filter(r => r.assistantId === assistantId || r.assistantId === null);
    assistantRules.forEach(r => hashParts.push({ id: `rule:${r.id}`, updatedAt: r.updatedAt }));
    const s4content = {
        rules: assistantRules.map(r => ({
            id: r.id, text: r.ruleText, platform: r.platform ?? 'global',
            origin: r.origin, createdAt: r.createdAt,
        })),
    };
    sections['4-content-rules'] = {
        status: assistantRules.length > 0 ? 'complete' : 'partial',
        content: s4content,
        sources: assistantRules.map(r => src('content_rules', 'rule_text', r.id, r.updatedAt)),
    };

    // ── Section 5 — USER & ORGANISATION CONTEXT ───────────────────────────────
    const [org] = await db.select().from(organisations).where(eq(organisations.id, asst.organisationId)).limit(1);
    const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, asst.userId)).limit(1);
    if (org) hashParts.push({ id: `org:${org.id}`, updatedAt: org.updatedAt });
    if (profile) hashParts.push({ id: `profile:${profile.id}`, updatedAt: null });

    const s5content = {
        businessName: org?.name ?? null,
        displayName: profile?.displayName ?? null,
        language: profile?.timezone ?? null,
        // Extended fields come from onboardingContext when not yet normalised on organisations
        industry: (onboardingCtx.industry as string | null) ?? null,
        targetAudience: (onboardingCtx.target_audience as string | null) ?? null,
        brandVoice: (onboardingCtx.brand_voice as string | null) ?? (onboardingCtx.tone_of_voice as string | null) ?? null,
        toneOfVoice: (onboardingCtx.tone_of_voice as string | null) ?? null,
    };
    if (!s5content.businessName) missing.push({ section: '5-org-context', field: 'businessName', sourceTable: 'organisations', sourceColumn: 'name', severity: 'warning' });
    sections['5-org-context'] = {
        status: sectionStatus(s5content, ['businessName', 'targetAudience', 'brandVoice']),
        content: s5content,
        sources: [
            src('organisations', 'name', org?.id ?? null, org?.updatedAt),
            src('user_profiles', 'display_name', profile?.id ?? null, null),
        ],
    };

    // ── Section 6 — ONBOARDING ANSWERS ───────────────────────────────────────
    const s6content = { answers: onboardingCtx };
    const hasAnswers = Object.keys(onboardingCtx).length > 0;
    if (!hasAnswers) missing.push({ section: '6-onboarding', field: 'onboardingContext', sourceTable: 'ai_assistants', sourceColumn: 'onboarding_context', severity: 'warning' });
    sections['6-onboarding'] = {
        status: hasAnswers ? 'complete' : 'missing',
        content: s6content,
        sources: [src('ai_assistants', 'onboarding_context', asst.id, asst.updatedAt)],
    };

    // ── Section 7 — ACTIVE INTEGRATIONS ──────────────────────────────────────
    const conns = await db.select().from(systemConnections)
        .where(and(eq(systemConnections.userId, asst.userId), eq(systemConnections.isActive, true)));
    const auths = await db.select().from(integrationAuthorizations)
        .where(and(eq(integrationAuthorizations.workspaceId, asst.organisationId), isNull(integrationAuthorizations.revokedAt)));
    conns.forEach(c => hashParts.push({ id: `conn:${c.id}`, updatedAt: c.updatedAt }));
    const s7content = {
        connections: conns.map(c => ({
            id: c.id, service: c.serviceName, type: c.connectionType,
            scopes: c.scopes, status: c.status,
            hitlRequired: auths.find(a => a.integrationType === c.serviceName)?.humanApprovalRequired ?? true,
        })),
    };
    sections['7-integrations'] = {
        status: conns.length > 0 ? 'complete' : 'partial',
        content: s7content,
        sources: conns.map(c => src('system_connections', 'service_name', c.id, c.updatedAt)),
    };

    // ── Section 8 — PLAN & CAPABILITY CONSTRAINTS ─────────────────────────────
    const [plan] = await db.select().from(plans)
        .where(and(eq(plans.organisationId, asst.organisationId), eq(plans.status, 'active')))
        .limit(1);
    const [masterPlan] = plan?.masterPlanId
        ? await db.select().from(masterPlans).where(eq(masterPlans.id, plan.masterPlanId)).limit(1)
        : [null];
    const [counter] = await db.select().from(usageCounters).where(eq(usageCounters.organisationId, asst.organisationId)).limit(1);
    const flags = await db.select().from(featureFlags)
        .where(eq(featureFlags.enabled, true));
    if (plan) hashParts.push({ id: `plan:${plan.id}`, updatedAt: plan.updatedAt });

    const s8content = {
        planName: masterPlan?.name ?? plan?.planName ?? null,
        tierKey: masterPlan?.tierKey ?? null,
        monthlyTaskLimit: masterPlan?.monthlyTaskLimit ?? null,
        monthlyTokenLimit: masterPlan?.monthlyTokenLimit ?? null,
        appConnectionLimit: masterPlan?.appConnectionLimit ?? null,
        currentTasksUsed: counter?.taskCount ?? null,
        currentTokensUsed: counter?.tokenCount ?? null,
        activeFeatureFlags: flags.map(f => f.key),
    };
    if (!s8content.planName) missing.push({ section: '8-plan', field: 'planName', sourceTable: 'plans', sourceColumn: 'plan_name', severity: 'blocking' });
    sections['8-plan'] = {
        status: plan ? 'complete' : 'missing',
        content: s8content,
        sources: [
            src('plans', 'plan_name', plan?.id ?? null, plan?.updatedAt),
            src('master_plans', 'tier_key', masterPlan?.id ?? null, null),
        ],
    };

    // ── Section 9 — COMPLIANCE & GOVERNANCE ──────────────────────────────────
    const CURRENT_DPA = '1.0';
    const [dpa] = await db.select().from(dpaAcceptances)
        .where(and(eq(dpaAcceptances.organisationId, asst.organisationId), eq(dpaAcceptances.version, CURRENT_DPA)))
        .limit(1);
    if (dpa) hashParts.push({ id: `dpa:${dpa.id}`, updatedAt: dpa.acceptedAt });

    const s9content = {
        dpaVersion: dpa?.version ?? null,
        dpaAcceptedAt: dpa?.acceptedAt ?? null,
        riskClassification: master?.riskClassification ?? null,
        disclosureText: asst.disclosureText ?? null,
        hitlMode: (asst.configuration as Record<string, unknown> | null)?.hitlMode ?? 'require-approval',
    };
    if (!dpa) missing.push({ section: '9-compliance', field: 'dpaAcceptedAt', sourceTable: 'dpa_acceptances', sourceColumn: 'accepted_at', severity: 'blocking' });
    if (!asst.disclosureText) missing.push({ section: '9-compliance', field: 'disclosureText', sourceTable: 'ai_assistants', sourceColumn: 'disclosure_text', severity: 'warning' });
    sections['9-compliance'] = {
        status: sectionStatus(s9content, ['dpaAcceptedAt', 'riskClassification']),
        content: s9content,
        sources: [
            src('dpa_acceptances', 'accepted_at', dpa?.id ?? null, dpa?.acceptedAt),
            src('ai_assistants', 'disclosure_text', asst.id, asst.updatedAt),
        ],
    };

    // ── Section 10 — EXECUTION CONSTRAINTS ───────────────────────────────────
    const execConfig = (asst.configuration as Record<string, unknown> | null) ?? {};
    const s10content = {
        maxLlmCalls: execConfig.maxLlmCalls ?? null,
        maxToolCalls: execConfig.maxToolCalls ?? null,
        maxTokensGenerated: execConfig.maxTokensGenerated ?? null,
        maxWallClockMinutes: execConfig.maxWallClockMinutes ?? null,
        maxCostGbp: execConfig.maxCostGbp ?? null,
    };
    const hasBudgets = Object.values(s10content).some(v => v != null);
    if (!hasBudgets) missing.push({ section: '10-execution', field: 'executionBudgets', sourceTable: 'ai_assistants', sourceColumn: 'configuration', severity: 'warning' });
    sections['10-execution'] = {
        status: hasBudgets ? 'partial' : 'missing',
        content: s10content,
        sources: [src('ai_assistants', 'configuration', asst.id, asst.updatedAt)],
    };

    // ── Compute completeness ──────────────────────────────────────────────────
    const totalSections = 10;
    const completeSections = Object.values(sections).filter(s => s.status === 'complete').length;
    const partialSections = Object.values(sections).filter(s => s.status === 'partial').length;
    const completenessPercent = Math.round(((completeSections + partialSections * 0.5) / totalSections) * 100);

    // ── Version hash ──────────────────────────────────────────────────────────
    const version_hash = blueprintHash(hashParts);

    // ── Persist blueprint ─────────────────────────────────────────────────────
    const [row] = await db.insert(aiBlueprints).values({
        assistantId,
        organisationId: asst.organisationId,
        blueprintVersion: version_hash,
        compiledBy,
        triggerType,
        sections: sections as unknown as Record<string, unknown>,
        missingFields: missing as unknown as Record<string, unknown>[],
        completenessPercent,
    }).returning();

    return { blueprint: row, sections, missingFields: missing, completenessPercent, blueprintVersion: version_hash };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler: Handler = async (event) => {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let adminId: number;
    let adminRole: string | null;
    try {
        const payload = jwt.verify(match[1], jwtSecret) as { userId: number; adminRole?: string };
        adminId = payload.userId;
        adminRole = payload.adminRole ?? null;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    if (!adminRole || !ADMIN_ROLES.includes(adminRole)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required.' }) };
    }

    const assistantId = parseInt(event.queryStringParameters?.assistantId ?? '');
    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId required.' }) };

    const db = getDb();

    // POST: mark as sent
    if (event.httpMethod === 'POST') {
        const action = event.queryStringParameters?.action;
        if (action === 'send') {
            const [latest] = await db.select().from(aiBlueprints)
                .where(eq(aiBlueprints.assistantId, assistantId))
                .orderBy(desc(aiBlueprints.compiledAt))
                .limit(1);
            if (!latest) return { statusCode: 404, body: JSON.stringify({ error: 'No blueprint found.' }) };
            if ((latest.missingFields as MissingField[]).some(f => f.severity === 'blocking')) {
                return { statusCode: 422, body: JSON.stringify({ error: 'Blueprint has blocking gaps. Resolve them before sending.' }) };
            }
            await db.update(aiBlueprints)
                .set({ sentAt: new Date(), sentByAdminId: adminId })
                .where(eq(aiBlueprints.id, latest.id));
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
        }
        return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action.' }) };
    }

    // GET: compile or return history
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const history = event.queryStringParameters?.history === '1';
    if (history) {
        const rows = await db.select().from(aiBlueprints)
            .where(eq(aiBlueprints.assistantId, assistantId))
            .orderBy(desc(aiBlueprints.compiledAt))
            .limit(20);
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) };
    }

    const dryRun = event.queryStringParameters?.dryRun === '1';
    const triggerType = dryRun ? 'dry-run' : 'admin-manual';

    try {
        const result = await assembleBlueprint(assistantId, String(adminId), triggerType);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result),
        };
    } catch (err) {
        console.error('[assemble-blueprint]', err);
        return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
    }
};
