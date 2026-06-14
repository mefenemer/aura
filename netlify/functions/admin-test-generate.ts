// netlify/functions/admin-test-generate.ts
// US-ADM-4.3.3: Admin-only endpoint to trigger and poll a test generation against a compiled blueprint.
//
// POST  — create test job (admin auth required)
//   Body: { assistantId, blueprintId, platform, contextPrompt? }
//   Returns: { jobId, status: 'queued' }
//
// GET ?jobId=<uuid> — poll status; when complete, returns result + compliance check

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import { users, aiAssistants, aiBlueprints, contentGenerationJobs, scheduledPosts } from '../../db/schema';
import { isAdminRole } from '../../src/utils/rbac';

const JWT_SECRET = process.env.JWT_SECRET;

// Sonnet 4.6 pricing (USD per M tokens) → converted to GBP at 0.79
const INPUT_COST_GBP_PER_M  = 3 * 0.79;
const OUTPUT_COST_GBP_PER_M = 15 * 0.79;

const PLATFORM_CHAR_LIMITS: Record<string, number> = {
    instagram: 2200,
    linkedin:  3000,
    x:         280,
    facebook:  63206,
};

async function requireAdmin(event: any): Promise<{ userId: number; name: string } | null> {
    if (!JWT_SECRET) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], JWT_SECRET) as { userId: number }).userId; }
    catch { return null; }
    const db = getDb();
    const [row] = await db.select({ role: users.role, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
    if (!row || !isAdminRole(row.role)) return null;
    return { userId, name: row.name || `Admin #${userId}` };
}

function checkCompliance(caption: string, hashtags: string, sections: Record<string, any>, platform: string) {
    const fullText = `${caption} ${hashtags}`.toLowerCase();
    const limit = PLATFORM_CHAR_LIMITS[platform] ?? 2200;
    const captionLen = (caption || '').length;

    const contentRules: Array<{ rule: string; pass: boolean }> = [];
    const strictRules: Array<{ rule: string; pass: boolean }> = [];

    // Parse content rules from blueprint section 7
    const contentRulesSection = sections['7-content-rules']?.content || {};
    const strictRulesSection  = sections['8-strict-rules']?.content  || {};

    for (const [, v] of Object.entries(contentRulesSection)) {
        if (!v || typeof v !== 'string') continue;
        const rule = v.trim();
        if (!rule) continue;
        // Heuristic: if the rule contains a keyword found in the output, treat it as compliant
        const keywords = rule.toLowerCase().split(/\W+/).filter(w => w.length > 4);
        const pass = keywords.length === 0 || !keywords.some(kw => fullText.includes(kw) === false && kw.length > 6);
        contentRules.push({ rule, pass });
    }

    for (const [, v] of Object.entries(strictRulesSection)) {
        if (!v || typeof v !== 'string') continue;
        const rule = v.trim();
        if (!rule) continue;
        // Strict rules: presence-based check — if the rule mentions something to avoid, flag if it appears
        const lowerRule = rule.toLowerCase();
        const isProhibition = lowerRule.includes('do not') || lowerRule.includes('never') || lowerRule.includes('avoid') || lowerRule.includes('must not') || lowerRule.includes('prohibited');
        let pass = true;
        if (isProhibition) {
            const prohibitedTerms = rule.toLowerCase().split(/\W+/).filter(w => w.length > 5 && !['never', 'avoid', 'prohibited', 'donot', 'mustnot'].includes(w));
            pass = !prohibitedTerms.some(t => fullText.includes(t));
        }
        strictRules.push({ rule, pass });
    }

    // Disclosure text
    const disclosureText = sections['9-disclosure']?.content?.disclosureText as string | null;
    const disclosurePresent = !!disclosureText && disclosureText.trim().length > 0;

    return { contentRules, strictRules, disclosurePresent, disclosureText, captionLen, platformLimit: limit };
}

export const handler: Handler = async (event) => {
    const admin = await requireAdmin(event);
    if (!admin) return { statusCode: 401, body: JSON.stringify({ error: 'Admin auth required.' }) };

    const db = getDb();

    // ── GET: history list or job status poll ─────────────────────────────────
    if (event.httpMethod === 'GET') {
        const qs = event.queryStringParameters || {};

        // History: ?assistantId=N&history=1
        if (qs.history && qs.assistantId) {
            const asstId = parseInt(qs.assistantId);
            if (!asstId) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId required.' }) };

            const runs = await db.execute<{
                job_id: string; platform: string | null; context_prompt: string | null;
                created_at: string; tokens_input: number | null; tokens_output: number | null;
                caption: string | null; hashtags: string | null; suggested_media_description: string | null;
                admin_name: string | null;
            }>(`
                SELECT cj.job_id, cj.platform, cj.context_prompt, cj.created_at,
                       cj.tokens_input, cj.tokens_output,
                       sp.caption, sp.hashtags, sp.suggested_media_description,
                       u.name AS admin_name
                FROM content_generation_jobs cj
                LEFT JOIN scheduled_posts sp ON sp.job_id = cj.job_id
                LEFT JOIN users u ON u.id = cj.admin_id
                WHERE cj.assistant_id = ${asstId} AND cj.trigger_type = 'admin_test' AND cj.status = 'completed'
                ORDER BY cj.created_at DESC
                LIMIT 20
            `);

            const rows = runs.rows.map(r => ({
                jobId:                    r.job_id,
                platform:                 r.platform,
                contextPrompt:            r.context_prompt,
                createdAt:                r.created_at,
                tokensInput:              r.tokens_input,
                tokensOutput:             r.tokens_output,
                caption:                  r.caption,
                hashtags:                 r.hashtags,
                suggestedMediaDescription: r.suggested_media_description,
                adminName:                r.admin_name,
            }));

            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) };
        }

        const jobId = qs.jobId;
        if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: 'jobId required.' }) };

        const [job] = await db
            .select({
                status:      contentGenerationJobs.status,
                resultPostId: contentGenerationJobs.resultPostId,
                errorMessage: contentGenerationJobs.errorMessage,
                tokensInput:  contentGenerationJobs.tokensInput,
                tokensOutput: contentGenerationJobs.tokensOutput,
                blueprintId:  contentGenerationJobs.blueprintId,
                platform:     contentGenerationJobs.platform,
            })
            .from(contentGenerationJobs)
            .where(and(eq(contentGenerationJobs.jobId, jobId), eq(contentGenerationJobs.triggerType, 'admin_test')))
            .limit(1);

        if (!job) return { statusCode: 404, body: JSON.stringify({ error: 'Test job not found.' }) };

        if (job.status !== 'completed' || !job.resultPostId) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: job.status, errorMessage: job.errorMessage }),
            };
        }

        // Fetch the generated post
        const [post] = await db
            .select({ caption: scheduledPosts.caption, hashtags: scheduledPosts.hashtags, suggestedMediaDescription: scheduledPosts.suggestedMediaDescription })
            .from(scheduledPosts)
            .where(eq(scheduledPosts.id, job.resultPostId))
            .limit(1);

        // Fetch blueprint sections for compliance check
        let complianceResult = null;
        if (job.blueprintId) {
            const [bp] = await db.select({ sections: aiBlueprints.sections }).from(aiBlueprints).where(eq(aiBlueprints.id, job.blueprintId)).limit(1);
            if (bp) {
                complianceResult = checkCompliance(
                    post?.caption || '',
                    post?.hashtags || '',
                    bp.sections as Record<string, any>,
                    job.platform || 'instagram',
                );
            }
        }

        // Cost estimate
        const inputCostGbp  = job.tokensInput  ? (job.tokensInput  / 1_000_000) * INPUT_COST_GBP_PER_M  : null;
        const outputCostGbp = job.tokensOutput ? (job.tokensOutput / 1_000_000) * OUTPUT_COST_GBP_PER_M : null;
        const totalCostGbp  = (inputCostGbp ?? 0) + (outputCostGbp ?? 0);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: 'completed',
                post,
                compliance: complianceResult,
                tokens: { input: job.tokensInput, output: job.tokensOutput },
                costGbp: totalCostGbp > 0 ? parseFloat(totalCostGbp.toFixed(6)) : null,
            }),
        };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: { assistantId?: number; blueprintId?: number; platform?: string; contextPrompt?: string; saveReference?: boolean; jobId?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    // Save reference — just acknowledge; the data is already persisted in the job + scheduled_post
    if (body.saveReference && body.jobId) {
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ saved: true }) };
    }

    const { assistantId, blueprintId, platform = 'instagram', contextPrompt } = body;
    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required.' }) };
    if (contextPrompt && contextPrompt.length > 500) {
        return { statusCode: 400, body: JSON.stringify({ error: 'contextPrompt must be ≤500 characters.' }) };
    }

    // Resolve assistant + org
    const [asst] = await db
        .select({ id: aiAssistants.id, organisationId: aiAssistants.organisationId, userId: aiAssistants.userId })
        .from(aiAssistants)
        .where(eq(aiAssistants.id, assistantId))
        .limit(1);
    if (!asst) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };

    // Resolve blueprint
    const bpWhere = blueprintId
        ? eq(aiBlueprints.id, blueprintId)
        : eq(aiBlueprints.assistantId, assistantId);

    const [bp] = await db
        .select({ id: aiBlueprints.id, missingFields: aiBlueprints.missingFields })
        .from(aiBlueprints)
        .where(bpWhere)
        .orderBy(desc(aiBlueprints.compiledAt))
        .limit(1);

    if (!bp) return { statusCode: 404, body: JSON.stringify({ error: 'No compiled blueprint found for this assistant.' }) };

    const blockingGaps = ((bp.missingFields as Array<{ severity: string }>) || []).filter(f => f.severity === 'blocking');
    if (blockingGaps.length > 0) {
        return { statusCode: 422, body: JSON.stringify({ error: `Blueprint has ${blockingGaps.length} blocking gap(s). Resolve them before running a test.` }) };
    }

    const jobId = randomUUID();

    await db.insert(contentGenerationJobs).values({
        jobId,
        blueprintId:    bp.id,
        assistantId:    asst.id,
        organisationId: asst.organisationId,
        userId:         asst.userId,       // consumer's userId (used for DB FKs only)
        adminId:        admin.userId,      // the admin who triggered the test
        status:         'queued',
        attempt:        0,
        maxAttempts:    3,
        triggerType:    'admin_test',
        platform:       platform || null,
        contextPrompt:  contextPrompt || null,
    });

    return {
        statusCode: 202,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, status: 'queued' }),
    };
};
