// src/utils/tos-gate.ts
// US-GOV-1.2.1: Gate utility — returns a 403 response object if the user has not accepted
// the current ToS version, blocking all write operations until they do.
//
// Usage in any write endpoint:
//   const block = await requireTosAcceptance(userId);
//   if (block) return block;

import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { tosAcceptances } from '../../db/schema';
import { CURRENT_TOS_VERSION } from '../../netlify/functions/accept-tos';

interface GateResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

/**
 * Returns a 403 response if the user has not accepted the current ToS version.
 * Returns null if the user is up-to-date and the operation may proceed.
 * Read operations should NOT call this — only writes.
 */
export async function requireTosAcceptance(userId: number): Promise<GateResponse | null> {
    const db = getDb();
    const [row] = await db
        .select({ id: tosAcceptances.id })
        .from(tosAcceptances)
        .where(and(
            eq(tosAcceptances.userId, userId),
            eq(tosAcceptances.version, CURRENT_TOS_VERSION),
        ))
        .limit(1);

    if (row) return null; // accepted — allow the operation

    return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            error: 'Updated Terms of Service require acceptance before continuing.',
            code:  'TOS_ACCEPTANCE_REQUIRED',
            currentVersion: CURRENT_TOS_VERSION,
        }),
    };
}

// ── Prohibited-use category detection ────────────────────────────────────────

// Categories drawn from ToS clause 10.3 and 11.4
const PROHIBITED_USE_PATTERNS: { pattern: RegExp; category: string }[] = [
    {
        pattern: /\b(medical\s+advice|diagnosis|prognosis|prescription|medication|dosage|clinical\s+decision|treatment\s+plan|healthcare\s+recommendation)\b/i,
        category: 'health_medical',
    },
    {
        pattern: /\b(legal\s+advice|solicitor\s+advice|attorney\s+advice|contract\s+advice|litigation\s+strategy|legal\s+opinion)\b/i,
        category: 'legal_advice',
    },
    {
        pattern: /\b(financial\s+advice|investment\s+advice|portfolio\s+recommendation|buy.*sell.*stock|FCA.regulated|pension\s+advice|tax\s+advice)\b/i,
        category: 'financial_advice',
    },
    {
        pattern: /\b(regulated\s+product\s+claim|pharmaceutical\s+claim|medical\s+device\s+claim|nutraceutical\s+claim)\b/i,
        category: 'regulated_product_claims',
    },
];

export interface ProhibitedUseCheck {
    detected: boolean;
    categories: string[];
}

/**
 * Scans text (system prompt, assistant description, etc.) for prohibited-use patterns.
 * Returns { detected: false } if clean, otherwise { detected: true, categories: [...] }.
 */
export function checkProhibitedUsePatterns(text: string): ProhibitedUseCheck {
    const categories: string[] = [];
    for (const { pattern, category } of PROHIBITED_USE_PATTERNS) {
        if (pattern.test(text)) categories.push(category);
    }
    return { detected: categories.length > 0, categories };
}
