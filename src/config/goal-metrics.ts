// src/config/goal-metrics.ts
//
// Epic: AI-Driven SMART Goals — Feature 1 / metric catalog (the keystone).
//
// SINGLE SOURCE OF TRUTH for which Target Metrics a goal can be set against (AC1.1.2),
// what data source feeds each one, and which third-party connection it requires (AC1.1.3).
// The Goal Builder dropdown, the connection-gating, and the Phase-2 telemetry poller all
// read this catalog — add a new metric HERE, never inline at a call site.
//
// v1 scope: Instagram + internal metrics only (the data we can actually measure today —
// see [[smm-golive-readiness]]). HubSpot / Shopify / Salesforce etc. are added later as new
// catalog entries once their pollers exist.

export type MetricSource = 'connection' | 'internal';
export type MetricDirection = 'increase' | 'decrease';

export interface GoalMetric {
    /** Stable key persisted on goals.metric_key — never rename once shipped. */
    key: string;
    /** Human label shown in the builder dropdown. */
    label: string;
    /** Unit suffix for display, e.g. 'followers', '%'. */
    unit: string;
    /** Where the value comes from: a third-party connection, or our own DB. */
    source: MetricSource;
    /** For source==='connection': the system_connections.serviceName that must be active (AC1.1.3). */
    connectionService?: string;
    /** Whether progress = value going up or down. */
    direction: MetricDirection;
    /** One-line helper shown under the dropdown. */
    description: string;
    /**
     * Whether a Phase-2 telemetry poller can actually fetch this yet. Listed-but-not-yet-pollable
     * metrics still appear (so users can plan) but newly-created goals stay 'pending' until a poller
     * lands. Everything in v1 is wired to an existing data path, so all are true.
     */
    available: boolean;
}

export const GOAL_METRICS: readonly GoalMetric[] = [
    {
        key: 'instagram_followers',
        label: 'Instagram Followers',
        unit: 'followers',
        source: 'connection',
        connectionService: 'instagram',
        direction: 'increase',
        description: 'Total follower count on the connected Instagram account.',
        available: true,
    },
    {
        key: 'instagram_engagement_rate',
        label: 'Instagram Engagement Rate',
        unit: '%',
        source: 'connection',
        connectionService: 'instagram',
        direction: 'increase',
        description: 'Interactions ÷ reach across recent Instagram posts.',
        available: true,
    },
    {
        key: 'instagram_reach',
        label: 'Instagram Reach (30-day)',
        unit: 'accounts',
        source: 'connection',
        connectionService: 'instagram',
        direction: 'increase',
        description: 'Unique accounts reached by Instagram posts in the trailing 30 days.',
        available: true,
    },
    {
        key: 'qualified_leads',
        label: 'Qualified Leads',
        unit: 'leads',
        source: 'internal',
        direction: 'increase',
        description: 'Qualified leads captured in your Be More Swan workspace.',
        available: true,
    },
    {
        key: 'content_published',
        label: 'Content Published',
        unit: 'posts',
        source: 'internal',
        direction: 'increase',
        description: 'Posts this assistant has published.',
        available: true,
    },
];

const METRIC_BY_KEY: ReadonlyMap<string, GoalMetric> = new Map(GOAL_METRICS.map(m => [m.key, m]));

/** Look up a metric definition by its persisted key. */
export function getGoalMetric(key: string): GoalMetric | undefined {
    return METRIC_BY_KEY.get(key);
}

/** True if the metric key is in the catalog. */
export function isValidMetricKey(key: string): boolean {
    return METRIC_BY_KEY.has(key);
}

/**
 * AC1.1.3 — the metrics a workspace may actually pick: internal metrics are always available;
 * connection-backed metrics only when that service is currently connected.
 * @param connectedServices lowercased system_connections.serviceName values that are active
 */
export function availableMetricsForConnections(connectedServices: readonly string[]): GoalMetric[] {
    const connected = new Set(connectedServices.map(s => s.toLowerCase()));
    return GOAL_METRICS.filter(m =>
        m.source === 'internal' || (m.connectionService != null && connected.has(m.connectionService)),
    );
}

// ── Goal status model (AC1.2.3 / AC4.3.2) ───────────────────────────────────────
// Phase 1 only persists 'pending' (no telemetry yet); the run-rate engine in Phase 2 assigns the
// rest. Thresholds live here so they stay tunable without touching the engine.
export type GoalStatus = 'pending' | 'on_track' | 'at_risk' | 'off_track' | 'data_disconnected';

export const GOAL_STATUSES: readonly GoalStatus[] = [
    'pending', 'on_track', 'at_risk', 'off_track', 'data_disconnected',
];

export const RUN_RATE_THRESHOLDS = {
    /** actual ÷ required run-rate at or above this = on_track. */
    onTrack: 0.9,
    /** between offTrack and onTrack = at_risk; below offTrack = off_track. */
    offTrack: 0.7,
    /** hours without fresh telemetry before the goal flips to data_disconnected (AC4.3.2). */
    staleDataHours: 48,
} as const;
