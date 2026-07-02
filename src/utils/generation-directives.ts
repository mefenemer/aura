// src/utils/generation-directives.ts
// Shared, blueprint-derivable pieces of the per-post generation instruction.
//
// The runtime generators (process-content-jobs / admin-test-generate-background) build the LLM
// "user instruction" (baseInstruction) that hand-picks and WEIGHTS specific blueprint fields —
// content pillars, primary objective, service offerings, CTA/incentive/core message and the
// standing strategic principles. Previously that logic lived only inside the generators, so the
// admin Blueprint Inspector (which only renders the blueprint sections) could not show it — an
// admin validating "what the LLM actually sees" was missing ~half of it.
//
// Extracting the static, blueprint-derivable directives here lets the Inspector's Section 12
// render the EXACT same strings the generators feed the model (minus per-post runtime values:
// platform, post format, character limit, disclosure — those are resolved at generation time).

// US-SMM (AC4/AC5): algorithmic focus on Saves & Shares over vanity Likes; steer away from
// fleeting trends / vanity formats unless the user's context explicitly asks for them.
export const STRATEGIC_PRINCIPLES: string[] = [
    `STRATEGIC PRINCIPLES — apply these to every piece of content:`,
    `- Optimise for SAVES: make the post genuinely useful — structured educational value, practical tools, step-by-step or list formats the reader will want to keep.`,
    `- Optimise for SHARES: write relatable, "this is me" perspective content that makes the reader want to send it to someone who needs it.`,
    `- Do NOT optimise purely for Likes or follower count. Meaningful engagement (saves, shares, comments, DMs) is the goal.`,
    `- Avoid fleeting trends, viral dances, and vanity gimmicks unless the user's context explicitly asks for them. Favour authentic, on-brand value.`,
];

// US-SMM (AC2): Content Pillars — the user defines 3–5 themes (free-text or array). Parse into a
// discrete, capped list so every generated post can be categorised under exactly one of them.
export function parsePillars(raw: unknown): string[] {
    return (Array.isArray(raw) ? raw : String(raw ?? ''))
        .toString()
        .split(/[,;\n]/)
        .map(p => p.trim())
        .filter(Boolean)
        .slice(0, 5);
}

export function pillarDirective(pillars: string[]): string {
    return pillars.length
        ? `Content Pillars (categorise this post under EXACTLY ONE, returned verbatim in the "pillar" field): ${pillars.map(p => `"${p}"`).join(', ')}.`
        : '';
}

export function objectiveDirective(objective: string): string {
    return objective ? `Primary objective for this account: ${objective}.` : '';
}

// CTA / incentive / core message woven into the instruction as explicit, weighted lines.
export function extraContextLines(answers: Record<string, unknown>): string {
    const ctaLine         = answers['cta']          ? `Call to action: ${answers['cta']}` : '';
    const incentiveLine   = answers['incentive']    ? `Incentive/offer: ${answers['incentive']}` : '';
    const coreMessageLine = answers['core_message'] ? `Core message: ${answers['core_message']}` : '';
    return [ctaLine, incentiveLine, coreMessageLine].filter(Boolean).join('\n');
}

// US-SMM (AC7): conversion pathways. Offerings are woven in naturally on normal posts; a
// 'conversion' job produces a direct "path-to-working-with-me" post built around them.
export function offeringsDirective(
    serviceOfferings: string,
    opts: { isConversionPost: boolean; hasIncentive: boolean },
): string {
    if (!serviceOfferings) return '';
    return opts.isConversionPost
        ? `CONVERSION POST: write a direct "path-to-working-with-me" post. Make one of these offerings the clear next step, paired with the CTA${opts.hasIncentive ? ' and incentive' : ''} above. Lead with value/proof, then invite — confident, never pushy. Offerings: ${serviceOfferings}`
        : `Commercial offerings to weave in NATURALLY where it fits — never force a sell, most posts should give value first: ${serviceOfferings}`;
}

// The full strategy block: standing principles + the resolved pillar & objective directives.
export function buildStrategyBlock(answers: Record<string, unknown>): string {
    return [
        ...STRATEGIC_PRINCIPLES,
        pillarDirective(parsePillars(answers['content_pillars'])),
        objectiveDirective((answers['primary_objective'] as string) || ''),
    ].filter(Boolean).join('\n');
}
