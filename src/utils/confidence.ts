/**
 * src/utils/confidence.ts
 *
 * US-AUD-2.1.1: AI Confidence Indicator
 *
 * Wraps any LLM chat-completion call to append a self-assessment instruction,
 * parse the resulting confidence signal, and return it alongside the main content.
 *
 * Usage (in any future task-runner function):
 *
 *   import { buildConfidenceMessages, parseConfidenceResponse } from '../../src/utils/confidence';
 *
 *   const messages = buildConfidenceMessages(systemPrompt, userMessage);
 *   const raw = await callOpenAI(messages);
 *   const { content, confidenceLevel, verifyHint } = parseConfidenceResponse(raw);
 *   // Store confidenceLevel in taskRuns.metadata.confidenceLevel (SC5)
 */

export type ConfidenceLevel = 'green' | 'amber' | 'red';

export interface ConfidenceResult {
  /** The main output text, with the confidence JSON block stripped */
  content: string;
  /** green | amber | red — used for badge display (SC1) */
  confidenceLevel: ConfidenceLevel;
  /** AMBER only: one-line hint about what the user should verify (SC2) */
  verifyHint: string | null;
}

/**
 * Appends a structured confidence self-assessment instruction to the message array.
 * This is added as a secondary system instruction so it doesn't pollute the user-facing content.
 *
 * SC2: "Rate your own confidence in this response and identify the single element the user should verify."
 */
export function buildConfidenceMessages(
  systemPrompt: string,
  userMessage: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
): Array<{ role: string; content: string }> {
  const CONFIDENCE_INSTRUCTION = `

=== CONFIDENCE SELF-ASSESSMENT (append after your main response) ===
After your response, on a new line output EXACTLY this JSON block and nothing else after it:
{"__confidence":{"level":"green"|"amber"|"red","verifyHint":"<null or one sentence about what to verify>"}}

Rules:
- "green"  = you are highly confident in all facts, figures, and claims in your response.
- "amber"  = you are mostly confident but one specific element should be verified (e.g., a statistic, a date, a name). Set verifyHint to ONE sentence identifying it.
- "red"    = significant uncertainty; you recommend the user fact-check before relying on this output. Set verifyHint accordingly.
- verifyHint must be null for "green".
- Output the JSON block on its own line with no surrounding text.
`;

  return [
    { role: 'system', content: systemPrompt + CONFIDENCE_INSTRUCTION },
    ...history,
    { role: 'user', content: userMessage },
  ];
}

/**
 * Parses the raw LLM response string, extracts the confidence JSON block,
 * and returns the cleaned content + confidence metadata.
 *
 * Falls back to 'amber' with no hint if the model fails to include the block.
 */
export function parseConfidenceResponse(rawContent: string): ConfidenceResult {
  // Match the trailing JSON confidence block (flexible whitespace)
  const CONFIDENCE_REGEX = /\n?\s*\{"\s*__confidence\s*":\s*(\{[^}]+\})\s*\}/;
  const match = rawContent.match(CONFIDENCE_REGEX);

  if (!match) {
    // Model didn't follow the instruction — degrade gracefully to amber (SC6: never block output)
    return {
      content: rawContent.trim(),
      confidenceLevel: 'amber',
      verifyHint: 'This response could not be self-assessed. Please review before using.',
    };
  }

  // Strip the confidence block from the displayed content
  const content = rawContent.replace(match[0], '').trim();

  let parsed: { level?: string; verifyHint?: string | null } = {};
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { content, confidenceLevel: 'amber', verifyHint: null };
  }

  const level = (['green', 'amber', 'red'] as const).includes(parsed.level as ConfidenceLevel)
    ? (parsed.level as ConfidenceLevel)
    : 'amber';

  const verifyHint = level !== 'green' && typeof parsed.verifyHint === 'string'
    ? parsed.verifyHint
    : null;

  return { content, confidenceLevel: level, verifyHint };
}

/**
 * Renders a standalone confidence badge HTML string suitable for injection into
 * any output card in the workspace UI.
 *
 * SC1: Badge with colour-coded icon
 * SC2: AMBER includes a verifyHint line
 * SC3: RED includes a non-dismissable warning with click-through for Copy/Approve
 * SC4: GREEN — no additional prompt
 */
export function renderConfidenceBadgeHtml(
  level: ConfidenceLevel,
  verifyHint: string | null,
): string {
  if (level === 'green') {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"
                  title="High confidence — looks good">
      ✅ Looks good
    </span>`;
  }

  if (level === 'amber') {
    const hint = verifyHint
      ? `<p class="mt-1 text-xs text-amber-700">You should verify: ${verifyHint}</p>`
      : '';
    return `<div>
      <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200"
            title="Review recommended">
        ⚠️ Review recommended
      </span>
      ${hint}
    </div>`;
  }

  // red
  const hint = verifyHint
    ? `<p class="text-xs text-red-700 mt-1">You should verify: ${verifyHint}</p>`
    : '';
  return `<div class="rounded-lg bg-red-50 border border-red-200 px-3 py-2 mb-3">
    <div class="flex items-center gap-2">
      <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700 border border-red-200">
        ❌ Verify before using
      </span>
    </div>
    <p class="text-xs text-red-700 mt-1 font-semibold">
      This output has low confidence. We strongly recommend fact-checking before use.
    </p>
    ${hint}
  </div>`;
}
