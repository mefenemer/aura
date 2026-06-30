// src/utils/feature-roadmap.ts
// Shared constants/helpers for the admin Feature Roadmap board (see db/feature-roadmap.sql).

import { eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { featureRoadmap } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

// Priority signal. KEEP IN SYNC with db/feature-roadmap.sql feature_roadmap_priority_check.
export const ROADMAP_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type RoadmapPriority = (typeof ROADMAP_PRIORITIES)[number];

export const ROADMAP_PRIORITY_LABEL: Record<RoadmapPriority, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
};

export function isRoadmapPriority(v: unknown): v is RoadmapPriority {
    return typeof v === 'string' && (ROADMAP_PRIORITIES as readonly string[]).includes(v);
}

// Lifecycle. KEEP IN SYNC with db/feature-roadmap.sql feature_roadmap_status_check.
export const ROADMAP_STATUSES = ['planned', 'in_progress', 'shipped', 'declined'] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

export const ROADMAP_STATUS_LABEL: Record<RoadmapStatus, string> = {
    planned: 'Planned',
    in_progress: 'In Progress',
    shipped: 'Shipped',
    declined: 'Declined',
};

export function isRoadmapStatus(v: unknown): v is RoadmapStatus {
    return typeof v === 'string' && (ROADMAP_STATUSES as readonly string[]).includes(v);
}

/**
 * The sort_order to use for a brand-new item so it lands at the TOP of the board (lower
 * sorts higher). One below the current minimum; 0 for an empty board.
 */
export async function nextTopSortOrder(db: Db): Promise<number> {
    const [row] = await db
        .select({ min: sql<number | null>`min(${featureRoadmap.sortOrder})` })
        .from(featureRoadmap);
    const min = row?.min;
    return (typeof min === 'number' ? min : 0) - 1;
}

/**
 * Promote a reported issue to the Feature Roadmap. Idempotent: if a roadmap item already
 * exists for this issue, its priority/title/description are refreshed instead of inserting a
 * duplicate. New items are inserted at the top of the board. Returns the item id.
 */
export async function createRoadmapItemFromIssue(
    db: Db,
    opts: {
        issueId: number;
        title: string;
        description?: string | null;
        priority?: RoadmapPriority;
        createdBy?: number | null;
    },
): Promise<number> {
    const priority: RoadmapPriority = isRoadmapPriority(opts.priority) ? opts.priority : 'medium';
    const title = (opts.title || '').trim().slice(0, 200) || `Feature request from issue #${opts.issueId}`;
    const description = opts.description ?? null;

    const [existing] = await db
        .select({ id: featureRoadmap.id })
        .from(featureRoadmap)
        .where(eq(featureRoadmap.issueId, opts.issueId))
        .limit(1);

    if (existing) {
        await db.update(featureRoadmap)
            .set({ title, description, priority, updatedAt: new Date() })
            .where(eq(featureRoadmap.id, existing.id));
        return existing.id;
    }

    const sortOrder = await nextTopSortOrder(db);
    const [inserted] = await db.insert(featureRoadmap).values({
        title,
        description,
        priority,
        status: 'planned',
        sortOrder,
        source: 'issue',
        issueId: opts.issueId,
        createdBy: opts.createdBy ?? null,
    }).returning({ id: featureRoadmap.id });
    return inserted.id;
}
