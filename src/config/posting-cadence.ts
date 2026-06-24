// src/config/posting-cadence.ts
// Discrete posting-cadence catalog — the single source of truth shared by the assistant-detail
// dropdown (UI) and the periodic conversion-post scheduler (schedule-conversion-posts.ts).
//
// posting_frequency is STORED as the human label (e.g. "3 times a week") so every existing
// free-text reader (goal-ai prompts, autonomous optimiser, brief summary) keeps working
// naturally. postsPerWeekFor() maps any stored value — a canonical label, a canonical key, or
// legacy free text — back to a number the scheduler can reason about.

export interface PostingCadence {
    /** Stable machine key. */
    key: string;
    /** Human label — this is what we persist in onboarding_context.posting_frequency. */
    label: string;
    /** Posts per week; 0 means "on demand" (no periodic scheduling). */
    postsPerWeek: number;
}

export const POSTING_CADENCES: PostingCadence[] = [
    { key: 'daily',     label: 'Daily',          postsPerWeek: 7 },
    { key: '5x_week',   label: '5 times a week', postsPerWeek: 5 },
    { key: '3x_week',   label: '3 times a week', postsPerWeek: 3 },
    { key: '2x_week',   label: '2 times a week', postsPerWeek: 2 },
    { key: 'weekly',    label: 'Weekly',         postsPerWeek: 1 },
    { key: 'on_demand', label: 'On demand',      postsPerWeek: 0 },
];

const NUMBER_WORDS: Record<string, number> = {
    once: 1, one: 1, twice: 2, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
};

/**
 * Map a stored posting_frequency value to posts-per-week.
 *
 * Resolution order: canonical key → canonical label → free-text heuristics
 * ("3 times a week", "twice a day", "every day", "fortnightly", a bare number).
 * Returns 0 for on-demand / unrecognised (i.e. "do not schedule periodically").
 */
export function postsPerWeekFor(value: unknown): number {
    if (typeof value !== 'string') return 0;
    const raw = value.trim().toLowerCase();
    if (!raw) return 0;

    const byKey = POSTING_CADENCES.find(c => c.key === raw);
    if (byKey) return byKey.postsPerWeek;
    const byLabel = POSTING_CADENCES.find(c => c.label.toLowerCase() === raw);
    if (byLabel) return byLabel.postsPerWeek;

    // Free-text heuristics.
    if (/on[\s-]?demand|as needed|ad[\s-]?hoc|manual/.test(raw)) return 0;
    if (/fortnight|every (two|2) weeks|bi[\s-]?weekly/.test(raw)) return 0.5;
    if (/\bdaily\b|every ?day/.test(raw)) return 7;
    if (/\bweekly\b|every ?week/.test(raw)) return 1;

    // "<n> times a day" / "<n>x day"  → n*7 ;  "<n> times a week" / "<n>x week" → n.
    const perDay  = raw.match(/(\d+)\s*(?:x|times)?\s*(?:per|a|\/)?\s*day/);
    if (perDay)  return Number(perDay[1]) * 7;
    const perWeek = raw.match(/(\d+)\s*(?:x|times)?\s*(?:per|a|\/)?\s*week/);
    if (perWeek) return Number(perWeek[1]);

    // Word forms: "twice a day", "three times a week".
    for (const [word, n] of Object.entries(NUMBER_WORDS)) {
        if (new RegExp(`\\b${word}\\b.*\\bday`).test(raw)) return n * 7;
        if (new RegExp(`\\b${word}\\b.*\\bweek`).test(raw)) return n;
    }

    // Bare number → treat as per week.
    const bare = raw.match(/^(\d+)$/);
    if (bare) return Number(bare[1]);

    return 0;
}

/** Even spacing (in hours) between posts for a given cadence; null when not periodic. */
export function intervalHoursFor(value: unknown): number | null {
    const perWeek = postsPerWeekFor(value);
    if (perWeek <= 0) return null;
    return (7 * 24) / perWeek;
}
