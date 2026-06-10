// src/utils/disclaimer.ts
// US-AUD-4.3.1: AI output disclaimer utilities.

// SC3: High-risk category keywords for upgrading standard → warning disclaimer
const HIGH_RISK_PATTERNS: Array<{ category: string; keywords: RegExp }> = [
    {
        category: 'legal',
        keywords: /\b(legal\s+advice|solicitor|barrister|attorney|lawsuit|litigation|contract\s+clause|compliance|gdpr|libel|defamation|trademark|patent|copyright\s+infringement|indemnity|liability|negligence|jurisdiction|statute|regulation)\b/i,
    },
    {
        category: 'medical',
        keywords: /\b(medical\s+advice|diagnosis|prognosis|prescription|medication|dosage|treatment|symptom|clinical|doctor|physician|therapist|mental\s+health|healthcare|surgery|chronic|disease|disorder|syndrome)\b/i,
    },
    {
        category: 'financial',
        keywords: /\b(financial\s+advice|investment\s+advice|buy|sell|stock|shares|portfolio|returns|yield|interest\s+rate|mortgage|pension|retirement|tax\s+advice|accountant|forex|cryptocurrency|trading\s+strategy)\b/i,
    },
];

export type DisclaimerLevel = 'standard' | 'warning';

export interface DisclaimerResult {
    level: DisclaimerLevel;
    categories: string[]; // detected high-risk categories
}

/**
 * Analyse AI-generated content for high-risk category markers (SC3).
 * Returns the appropriate disclaimer level and detected categories.
 */
export function classifyOutput(content: string): DisclaimerResult {
    const detected: string[] = [];
    for (const pattern of HIGH_RISK_PATTERNS) {
        if (pattern.keywords.test(content)) {
            detected.push(pattern.category);
        }
    }
    return {
        level: detected.length > 0 ? 'warning' : 'standard',
        categories: detected,
    };
}

/**
 * Returns the HTML for the appropriate disclaimer (SC1/SC2/SC3).
 * Inject this beneath every AI output card in the UI.
 */
export function getDisclaimerHtml(level: DisclaimerLevel, categories: string[] = []): string {
    if (level === 'warning') {
        const catList = categories.join('/');
        return `<div class="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
  <span class="shrink-0 text-amber-500 text-sm">⚠️</span>
  <p class="text-xs text-amber-800 leading-relaxed">
    This output may contain <strong>${catList}</strong> information.
    Always consult a qualified professional before acting on this content.
  </p>
</div>`;
    }
    // SC1/SC2: Standard disclaimer
    return `<p class="mt-3 text-xs text-gray-400 italic">
  🤖 AI-generated content. Not verified. Do not act on legal, medical, or financial content without professional review.
</p>`;
}

/**
 * Client-side version of the disclaimer HTML (for use in workspace.html / task output rendering).
 */
export const STANDARD_DISCLAIMER_HTML = `<p class="mt-3 text-xs text-gray-400 italic">
  🤖 AI-generated content. Not verified. Do not act on legal, medical, or financial content without professional review.
</p>`;

export const HIGH_RISK_KEYWORDS_PATTERN = HIGH_RISK_PATTERNS.map(p => p.keywords.source).join('|');
