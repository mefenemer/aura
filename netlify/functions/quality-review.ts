// netlify/functions/quality-review.ts
// US-AUD-2.2.1: Secondary LLM quality review for AI output.
//
//  POST { content: string, assistantId?: number, tier?: 'basic' | 'premium' }
//   → { checks: ReviewCheck[], tier, upgradeHint? }

import { HandlerEvent } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users, userProfiles, aiAssistants, plans, masterPlans } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

interface ReviewCheck {
    label: string;
    status: 'pass' | 'warn';
    detail?: string;
}

// SC5: Tier gate — Tier 3+ gets full review
async function getUserTierLevel(db: any, userId: number): Promise<number> {
    const [user] = await db
        .select({ organisationId: users.organisationId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    if (!user?.organisationId) return 1;

    const [cheapest] = await db
        .select({ monthlyPriceGbp: masterPlans.monthlyPriceGbp })
        .from(masterPlans)
        .where(eq(masterPlans.isActive, true))
        .orderBy(masterPlans.monthlyPriceGbp)
        .limit(1);

    const [plan] = await db
        .select({ monthlyPriceGbp: masterPlans.monthlyPriceGbp })
        .from(plans)
        .innerJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.organisationId, user.organisationId), eq(plans.status, 'active')))
        .limit(1);

    if (!plan || !cheapest) return 1;
    const cheapestPrice = parseFloat(String(cheapest.monthlyPriceGbp));
    const orgPrice = parseFloat(String(plan.monthlyPriceGbp));
    if (orgPrice >= cheapestPrice * 4) return 4; // Tier 4
    if (orgPrice >= cheapestPrice * 3) return 3; // Tier 3
    if (orgPrice >= cheapestPrice * 2) return 2; // Tier 2
    return 1; // Tier 1 / solo
}

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    if (!OPENAI_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'AI service not configured.' }) };

    const rawCookies = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookies.split(';').map(c => {
            const [k, ...v] = c.trim().split('=');
            return [k, decodeURIComponent(v.join('='))];
        }).filter(([k]) => k !== '')
    );
    const sessionToken = cookies['aura_session'];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        const decoded = jwt.verify(sessionToken, jwtSecret) as { userId: number };
        userId = decoded.userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }

    const db = getDb();
    const body = JSON.parse(event.body || '{}');
    const { content, assistantId } = body;

    if (!content || typeof content !== 'string' || content.trim().length < 10) {
        return { statusCode: 400, body: JSON.stringify({ error: 'content is required.' }) };
    }

    // Get tier
    const tierLevel = await getUserTierLevel(db, userId);
    const isPremium = tierLevel >= 3; // SC4: Tier 3/4 get full review

    // Get brand voice context for tone check if premium
    let brandVoiceContext = '';
    if (isPremium && assistantId) {
        const [assistant] = await db
            .select({ systemPrompt: aiAssistants.systemPrompt, onboardingContext: aiAssistants.onboardingContext })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.userId, userId)))
            .limit(1);
        if (assistant?.systemPrompt) brandVoiceContext = assistant.systemPrompt.slice(0, 500);
    }

    // Build the review prompt
    const basicPrompt = `You are a quality review assistant. Analyse the following AI-generated content for quality issues.

CONTENT TO REVIEW:
"""
${content.slice(0, 3000)}
"""

Perform ONLY these 3 checks and respond in JSON:
1. Factual red flags: Check for any specific claims that could be verified (named statistics, dates, persons, URLs). If found, flag them.
2. Tone: Check if the tone is professional and appropriate for a business context.
3. Hallucination markers: Check for internal contradictions, invented URLs, or fictional citations.

Return ONLY valid JSON in this exact format:
{
  "factual": { "status": "pass" | "warn", "detail": "brief note if warn" },
  "tone": { "status": "pass" | "warn", "detail": "brief note if warn" },
  "hallucination": { "status": "pass" | "warn", "detail": "brief note if warn" }
}`;

    const premiumAddition = isPremium && brandVoiceContext ? `
4. Brand voice alignment: Compare the content tone against this brand voice guide: "${brandVoiceContext}". Score 0-100.
5. Competitor mentions: Flag any competitor brand names.
6. Legal/compliance: Flag any legal, regulatory, or compliance terminology that should be reviewed.

Add to JSON:
  "brandVoice": { "score": 0-100, "status": "pass"|"warn", "detail": "..." },
  "competitors": { "status": "pass"|"warn", "detail": "..." },
  "compliance": { "status": "pass"|"warn", "detail": "..." }` : '';

    const reviewPrompt = basicPrompt + (isPremium ? premiumAddition : '');

    try {
        const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: reviewPrompt }],
                max_tokens: 500,
                temperature: 0.1,
            }),
        });

        if (!openaiRes.ok) {
            return { statusCode: 502, body: JSON.stringify({ error: 'Review service temporarily unavailable.' }) };
        }

        const openaiData = await openaiRes.json();
        const rawText = openaiData.choices?.[0]?.message?.content || '{}';

        // Parse JSON from LLM response
        let reviewResult: Record<string, any> = {};
        try {
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            reviewResult = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
        } catch {
            reviewResult = {};
        }

        // Format into structured checks (SC3: max 3 lines for basic)
        const checks: ReviewCheck[] = [
            {
                label: reviewResult.factual?.status === 'warn'
                    ? `⚠️ Potential issue: ${reviewResult.factual?.detail || 'Factual claim detected — verify before use'}`
                    : '✅ No factual red flags detected',
                status: reviewResult.factual?.status || 'pass',
            },
            {
                label: reviewResult.tone?.status === 'warn'
                    ? `⚠️ Potential issue: ${reviewResult.tone?.detail || 'Tone may not match expected style'}`
                    : '✅ Tone appropriate',
                status: reviewResult.tone?.status || 'pass',
            },
            {
                label: reviewResult.hallucination?.status === 'warn'
                    ? `⚠️ Potential issue: ${reviewResult.hallucination?.detail || 'Possible hallucination markers detected'}`
                    : '✅ No hallucination markers detected',
                status: reviewResult.hallucination?.status || 'pass',
            },
        ];

        // SC4: Premium additional checks
        if (isPremium) {
            if (reviewResult.brandVoice) {
                checks.push({
                    label: reviewResult.brandVoice.status === 'warn'
                        ? `⚠️ Brand voice: ${reviewResult.brandVoice.detail || `Score: ${reviewResult.brandVoice.score}/100`}`
                        : `✅ Brand voice aligned (${reviewResult.brandVoice.score}/100)`,
                    status: reviewResult.brandVoice.status || 'pass',
                    detail: `Score: ${reviewResult.brandVoice.score}/100`,
                });
            }
            if (reviewResult.competitors) {
                checks.push({
                    label: reviewResult.competitors.status === 'warn'
                        ? `⚠️ Competitor mention: ${reviewResult.competitors.detail}`
                        : '✅ No competitor names detected',
                    status: reviewResult.competitors.status || 'pass',
                });
            }
            if (reviewResult.compliance) {
                checks.push({
                    label: reviewResult.compliance.status === 'warn'
                        ? `⚠️ Compliance flag: ${reviewResult.compliance.detail}`
                        : '✅ No compliance issues detected',
                    status: reviewResult.compliance.status || 'pass',
                });
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                checks,
                tier: isPremium ? 'premium' : 'basic',
                // SC5: upgrade hint for Tier 1/2
                upgradeHint: !isPremium
                    ? 'Full brand voice analysis and compliance checking available on Tier 3+.'
                    : null,
            }),
        };
    } catch (err) {
        console.error('quality-review error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Quality review failed.' }) };
    }
};
