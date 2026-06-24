// src/lib/fal-gateway.ts
// Centralized Fal.ai gateway for native AI media generation (Epic 1).
// Mirrors the env-config philosophy of ai-gateway.ts: swapping the target model is an
// env-var change, never a code change.
//
// Transport: Fal's queue API (https://docs.fal.ai/model-endpoints/queue).
//   submit()  POST https://queue.fal.run/{model}            → { request_id, status_url, response_url }
//   status()  GET  {status_url}                              → { status: IN_QUEUE|IN_PROGRESS|COMPLETED }
//   result()  GET  {response_url}                            → model output payload
//   runSync() submit + poll until COMPLETED (bounded)        — for fast jobs (images)
//
// Config:
//   FAL_KEY           — API key (required; gateway is mock/disabled without it)
//   FAL_IMAGE_MODEL   — defaults to 'fal-ai/flux-2'              (Flux 2, 1 credit)
//   FAL_VIDEO_MODEL   — defaults to 'fal-ai/minimax/hailuo-2.3'  (Hailuo 2.3, 5 credits)

const FAL_KEY     = process.env.FAL_KEY;
const IMAGE_MODEL = process.env.FAL_IMAGE_MODEL ?? 'fal-ai/flux-2';
const VIDEO_MODEL = process.env.FAL_VIDEO_MODEL ?? 'fal-ai/minimax/hailuo-2.3';

const QUEUE_BASE = 'https://queue.fal.run';

// ── Types ────────────────────────────────────────────────────────────────────

export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:5';
export const ASPECT_RATIOS: AspectRatio[] = ['1:1', '16:9', '9:16', '4:5'];

export type FalJobStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';

export interface FalSubmitResult {
    requestId: string;
    statusUrl: string;
    responseUrl: string;
}

export interface GeneratedImage {
    url: string;
    width: number | null;
    height: number | null;
    contentType: string;   // e.g. 'image/png'
}

export interface GeneratedVideo {
    url: string;
    contentType: string;   // e.g. 'video/mp4'
}

/** Thrown when Fal rejects a prompt for safety / content-policy reasons (AC: US1/US2 error handling). */
export class FalContentPolicyError extends Error {
    constructor(message = 'Prompt flagged for policy violation.') {
        super(message);
        this.name = 'FalContentPolicyError';
    }
}

/** Thrown for any other Fal transport/model error. */
export class FalError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'FalError';
    }
}

/** True when FAL_KEY is absent — callers can short-circuit to mock behaviour in dev. */
export function falConfigured(): boolean {
    return !!FAL_KEY;
}

// ── Aspect-ratio mapping ───────────────────────────────────────────────────────

// Flux 2 accepts a named `image_size` preset. Map our UI aspect ratios onto the
// closest preset; 4:5 has no exact preset so we pass explicit dimensions.
function imageSizeForAspect(aspect: AspectRatio): string | { width: number; height: number } {
    switch (aspect) {
        case '1:1':  return 'square_hd';          // 1024×1024
        case '16:9': return 'landscape_16_9';     // 1280×720
        case '9:16': return 'portrait_16_9';      // 720×1280
        case '4:5':  return { width: 1024, height: 1280 };
    }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
    if (!FAL_KEY) throw new FalError('FAL_KEY is not configured.');
    return { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' };
}

// Fal signals content-policy rejection with 422 (and sometimes 400) plus a detail
// string mentioning safety/NSFW/policy. Distinguish it from generic failures so the
// UI can show the friendly "adjust your text" message and we can refund the credit hold.
function isPolicyRejection(status: number, bodyText: string): boolean {
    if (status !== 422 && status !== 400) return false;
    return /nsfw|safety|content[_ ]?polic|moderation|flagged|prohibited/i.test(bodyText);
}

async function postJson(url: string, payload: unknown): Promise<any> {
    const res = await fetch(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    const text = await res.text();
    if (!res.ok) {
        if (isPolicyRejection(res.status, text)) throw new FalContentPolicyError();
        throw new FalError(`Fal request failed (${res.status}): ${text.slice(0, 300)}`, res.status);
    }
    return text ? JSON.parse(text) : {};
}

async function getJson(url: string): Promise<any> {
    const res = await fetch(url, { headers: { Authorization: `Key ${FAL_KEY}` } });
    const text = await res.text();
    if (!res.ok) {
        if (isPolicyRejection(res.status, text)) throw new FalContentPolicyError();
        throw new FalError(`Fal poll failed (${res.status}): ${text.slice(0, 300)}`, res.status);
    }
    return text ? JSON.parse(text) : {};
}

// ── Queue primitives ────────────────────────────────────────────────────────────

/** Submit a job to the Fal queue. Returns the request + polling URLs. */
export async function submit(model: string, input: Record<string, unknown>): Promise<FalSubmitResult> {
    const data = await postJson(`${QUEUE_BASE}/${model}`, input);
    if (!data?.request_id || !data?.status_url || !data?.response_url) {
        throw new FalError('Fal submit returned an unexpected payload.');
    }
    return { requestId: data.request_id, statusUrl: data.status_url, responseUrl: data.response_url };
}

/** Poll a queued job's status. */
export async function status(statusUrl: string): Promise<FalJobStatus> {
    const data = await getJson(statusUrl);
    return (data?.status as FalJobStatus) ?? 'IN_PROGRESS';
}

/** Fetch the final result payload of a COMPLETED job. */
export async function result(responseUrl: string): Promise<any> {
    return getJson(responseUrl);
}

/**
 * Submit then poll until COMPLETED or timeout. Use for fast jobs (images); slow jobs
 * (video) should submit() and poll across requests via a background worker.
 */
async function runSync(model: string, input: Record<string, unknown>, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<any> {
    const timeoutMs  = opts?.timeoutMs  ?? 60_000;
    const intervalMs = opts?.intervalMs ?? 1_500;
    const { statusUrl, responseUrl } = await submit(model, input);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const s = await status(statusUrl);
        if (s === 'COMPLETED') return result(responseUrl);
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new FalError('Fal job timed out before completion.', 504);
}

// ── Public generation helpers ─────────────────────────────────────────────────

/** Generate up to `numImages` image variations with Flux 2. Resolves to ephemeral Fal URLs. */
export async function generateImages(opts: {
    prompt: string;
    aspectRatio: AspectRatio;
    numImages?: number;
    timeoutMs?: number;
}): Promise<GeneratedImage[]> {
    const input: Record<string, unknown> = {
        prompt: opts.prompt,
        image_size: imageSizeForAspect(opts.aspectRatio),
        num_images: Math.min(Math.max(opts.numImages ?? 4, 1), 4),
    };
    const out = await runSync(IMAGE_MODEL, input, { timeoutMs: opts.timeoutMs ?? 90_000 });
    const images: any[] = out?.images ?? [];
    if (!images.length) throw new FalError('Fal returned no images.');
    return images.map(img => ({
        url: img.url,
        width: img.width ?? null,
        height: img.height ?? null,
        contentType: img.content_type ?? 'image/png',
    }));
}

/** Submit an async video generation job with Hailuo 2.3. Poll with status()/result(). */
export async function submitVideo(opts: {
    prompt: string;
    aspectRatio: AspectRatio;
    durationSeconds: number;
}): Promise<FalSubmitResult> {
    const input: Record<string, unknown> = {
        prompt: opts.prompt,
        aspect_ratio: opts.aspectRatio,
        duration: String(opts.durationSeconds),
    };
    return submit(VIDEO_MODEL, input);
}

/** Extract the mp4 video URL from a COMPLETED Hailuo job result payload. */
export function extractVideo(resultPayload: any): GeneratedVideo {
    const video = resultPayload?.video ?? resultPayload?.videos?.[0];
    if (!video?.url) throw new FalError('Fal video result missing a URL.');
    return { url: video.url, contentType: video.content_type ?? 'video/mp4' };
}
