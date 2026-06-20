// pexels.ts — Pexels image sourcing for the Social Media Assistant.
//
// Solves "where do post images come from": search Pexels for legally-safe stock images
// (US1), guarantee an image is never reused across a workspace's feed (US2, HARD rule),
// and respect Pexels' ToS — hotlink-only, attribution, rate limits (US3).
//
// We NEVER download/host the raw bytes permanently: the Pexels CDN URL is stored as
// contentAssets.externalUrl and hotlinked at publish time by resolvePostImage()
// (src/utils/social-publish.ts). See US3 AC3.1.

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, postedAssets, scheduledPosts, scheduledPostAssets } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';

type Db = ReturnType<typeof getDb>;

// US3 AC3.4: user-facing copy when Pexels returns HTTP 429.
export const PEXELS_RATE_LIMIT_MESSAGE = 'Content search is resting. Please try again in a few minutes.';

// Thrown on a Pexels 429 so callers can map it to PEXELS_RATE_LIMIT_MESSAGE.
export class PexelsRateLimitError extends Error {
    constructor() {
        super(PEXELS_RATE_LIMIT_MESSAGE);
        this.name = 'PexelsRateLimitError';
    }
}

export interface PexelsCandidate {
    providerAssetId: string;   // Pexels photo id (string)
    url: string;               // CDN URL (src.large) — hotlinked, never permanently hosted
    title: string;             // alt text / description
    photographer: string;      // US3 AC3.2
    photographerUrl: string;   // US3 AC3.2
    width: number;
    height: number;
}

const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search';

// US1 AC1.2: turn a post's topic / suggestedMediaDescription into a short, specific query.
export async function generateImageKeywords(context: string): Promise<string> {
    const trimmed = (context || '').trim();
    if (!trimmed) return '';
    try {
        const { text } = await gatewayGenerate({
            system:
                'You generate concise stock-photo search keywords. Given a social post topic or media ' +
                'description, return 2–4 specific, visual search keywords (no hashtags, no punctuation, ' +
                'no quotes) best suited to finding a relevant photo. Reply with ONLY the keywords.',
            messages: [{ role: 'user', content: trimmed.slice(0, 500) }],
            maxTokens: 30,
        });
        const keywords = text.replace(/["'\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
        return keywords || trimmed.slice(0, 80);
    } catch {
        // LLM failure must not block image sourcing — fall back to the raw context.
        return trimmed.slice(0, 80);
    }
}

// US1 AC1.3/1.4: GET the Pexels search endpoint with safe_search forced on.
export async function pexelsSearch(query: string, page = 1, perPage = 15): Promise<PexelsCandidate[]> {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) throw new Error('PEXELS_API_KEY is not configured.');
    if (!query.trim()) return [];

    const params = new URLSearchParams({
        query,
        per_page: String(perPage),
        page: String(page),
        safe_search: 'true',   // US1 AC1.4 — never pull explicit content
    });

    const res = await fetch(`${PEXELS_SEARCH_URL}?${params}`, {
        headers: { Authorization: apiKey },
    });

    if (res.status === 429) throw new PexelsRateLimitError();   // US3 AC3.4
    if (!res.ok) throw new Error(`Pexels API error (${res.status})`);

    const data: any = await res.json().catch(() => ({}));
    const photos: any[] = Array.isArray(data?.photos) ? data.photos : [];
    return photos.map(p => ({
        providerAssetId: String(p.id),
        url: p?.src?.large || p?.src?.large2x || p?.src?.original || '',
        title: (p?.alt || '').trim() || `Pexels photo ${p.id}`,
        photographer: p?.photographer || 'Unknown',
        photographerUrl: p?.photographer_url || '',
        width: Number(p?.width) || 0,
        height: Number(p?.height) || 0,
    })).filter(c => c.url && c.providerAssetId);
}

// US2 AC2.2/2.3 (HARD rule): strip any candidate whose Pexels ID is already in posted_assets
// for this organisation, BEFORE it is presented to the LLM or user.
export async function filterUnique(db: Db, orgId: number, candidates: PexelsCandidate[]): Promise<PexelsCandidate[]> {
    if (!candidates.length) return [];
    const ids = candidates.map(c => c.providerAssetId);
    const used = await db
        .select({ providerAssetId: postedAssets.providerAssetId })
        .from(postedAssets)
        .where(and(
            eq(postedAssets.organisationId, orgId),
            eq(postedAssets.provider, 'pexels'),
            inArray(postedAssets.providerAssetId, ids),
        ));
    const usedSet = new Set(used.map(u => u.providerAssetId));
    return candidates.filter(c => !usedSet.has(c.providerAssetId));
}

export interface SearchResult { keywords: string; candidates: PexelsCandidate[]; }

// US1 AC1.5 + US2 AC2.4: keywords → search page 1 → strip dupes → if none remain, pull page 2.
export async function searchUniqueImages(
    db: Db,
    orgId: number,
    context: string,
    { limit = 5 }: { limit?: number } = {},
): Promise<SearchResult> {
    const keywords = await generateImageKeywords(context);
    if (!keywords) return { keywords, candidates: [] };

    let unique = await filterUnique(db, orgId, await pexelsSearch(keywords, 1));
    if (unique.length === 0) {
        // US2 AC2.4: first page was all duplicates — automatically request page 2.
        unique = await filterUnique(db, orgId, await pexelsSearch(keywords, 2));
    }
    return { keywords, candidates: unique.slice(0, limit) };
}

// US3 AC3.3: subtle, non-intrusive attribution line appended to the draft.
export function creditLine(photographer: string): string {
    return `\n\nPhoto by ${photographer} on Pexels`;
}

// Create a contentAssets row for a Pexels candidate (externalUrl = CDN URL → hotlinked),
// attach it to the post via the scheduledPostAssets junction, and keep the deprecated
// contentAssetIds array in sync during the migration window. Returns the new asset id.
export async function attachPexelsImageToPost(
    db: Db,
    args: { postId: number; userId: number; orgId: number | null; candidate: PexelsCandidate },
): Promise<number> {
    const { postId, userId, orgId, candidate } = args;

    const [asset] = await db.insert(contentAssets).values({
        userId,
        organisationId: orgId ?? null,
        name: candidate.title,
        assetType: 'image',
        mimeType: 'image/jpeg',
        externalUrl: candidate.url,         // US3 AC3.1 — hotlink, never permanently hosted
        provider: 'pexels',
        providerAssetId: candidate.providerAssetId,
        attributionName: candidate.photographer,   // US3 AC3.2
        attributionUrl: candidate.photographerUrl, // US3 AC3.2
        status: 'pending',
    }).returning({ id: contentAssets.id });

    await db.insert(scheduledPostAssets)
        .values({ scheduledPostId: postId, contentAssetId: asset.id, position: 0 })
        .onConflictDoNothing();

    // Keep the deprecated JSONB array in sync so resolvePostImage() (which reads it) works today.
    const [post] = await db.select({ ids: scheduledPosts.contentAssetIds })
        .from(scheduledPosts).where(eq(scheduledPosts.id, postId)).limit(1);
    const existing = Array.isArray(post?.ids) ? (post!.ids as number[]) : [];
    if (!existing.includes(asset.id)) {
        await db.update(scheduledPosts)
            .set({ contentAssetIds: [...existing, asset.id], updatedAt: new Date() })
            .where(eq(scheduledPosts.id, postId));
    }

    return asset.id;
}

// US2 AC2.5: once a post is scheduled or published, write its chosen Pexels asset IDs to
// posted_assets so they can never be reused. Idempotent (unique constraint + onConflictDoNothing),
// so it is safe to call from both the approval and publish hooks.
export async function recordPostedAssets(
    db: Db,
    args: { orgId: number; userId?: number | null; scheduledPostId: number },
): Promise<void> {
    const { orgId, userId = null, scheduledPostId } = args;

    const rows = await db
        .select({ assetId: contentAssets.id, providerAssetId: contentAssets.providerAssetId })
        .from(scheduledPostAssets)
        .innerJoin(contentAssets, eq(scheduledPostAssets.contentAssetId, contentAssets.id))
        .where(and(
            eq(scheduledPostAssets.scheduledPostId, scheduledPostId),
            eq(contentAssets.provider, 'pexels'),
            isNotNull(contentAssets.providerAssetId),
        ));

    if (!rows.length) return;

    await db.insert(postedAssets)
        .values(rows.map(r => ({
            organisationId: orgId,
            userId: userId ?? null,
            provider: 'pexels',
            providerAssetId: r.providerAssetId!,
            scheduledPostId,
            contentAssetId: r.assetId,
        })))
        .onConflictDoNothing();
}
