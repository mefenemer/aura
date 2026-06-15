/**
 * src/utils/rate-limit.ts
 *
 * US-GAP-7.1.1: API Rate Limiting on Public Endpoints
 *
 * Uses a PostgreSQL table to track attempts per key+endpoint within a sliding window.
 * Call checkRateLimit() at the top of each handler before doing any processing.
 *
 * Usage:
 *   const result = await checkRateLimit(db, 'register', ipAddress, { maxAttempts: 5, windowSecs: 60 });
 *   if (!result.allowed) {
 *     return { statusCode: 429, body: JSON.stringify({ error: 'Too many requests. Please try again later.' }) };
 *   }
 */

import { gte, and, eq, count, lt } from 'drizzle-orm';
import { rateLimitAttempts } from '../../db/schema';

export interface RateLimitOptions {
  /** Maximum number of attempts allowed within the window */
  maxAttempts: number;
  /** Sliding window size in seconds */
  windowSecs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest attempt in the window expires (for Retry-After header) */
  retryAfterSecs: number;
}

/**
 * Check and record a rate-limit attempt.
 *
 * @param db          Drizzle DB instance
 * @param endpoint    Short endpoint identifier ('register' | 'login' | 'onboarding' | 'support')
 * @param key         IP address or 'user:<userId>' string
 * @param opts        { maxAttempts, windowSecs }
 */
export async function checkRateLimit(
  db: any,
  endpoint: string,
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const { maxAttempts, windowSecs } = opts;
  const windowStart = new Date(Date.now() - windowSecs * 1000);

  // Count existing attempts within the window for this key+endpoint
  const [{ value: existingCount }] = await db
    .select({ value: count() })
    .from(rateLimitAttempts)
    .where(and(
      eq(rateLimitAttempts.key, key),
      eq(rateLimitAttempts.endpoint, endpoint),
      gte(rateLimitAttempts.attemptedAt, windowStart),
    ));

  if (existingCount >= maxAttempts) {
    return { allowed: false, retryAfterSecs: windowSecs };
  }

  // Record this attempt
  await db.insert(rateLimitAttempts).values({ key, endpoint });

  // Prune stale rows for this key+endpoint (keep DB lean — remove entries older than 24h)
  const pruneThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await db
    .delete(rateLimitAttempts)
    .where(and(
      eq(rateLimitAttempts.key, key),
      eq(rateLimitAttempts.endpoint, endpoint),
      lt(rateLimitAttempts.attemptedAt, pruneThreshold),
    ))
    .catch(() => { /* non-blocking — pruning failure should never break the request */ });

  return { allowed: true, retryAfterSecs: 0 };
}

/**
 * Extracts a client IP address from Netlify function event headers.
 * Netlify passes the real client IP in x-nf-client-connection-ip or x-forwarded-for.
 */
export function getClientIp(headers: Record<string, string | undefined>): string {
  return (
    headers['x-nf-client-connection-ip'] ||
    headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    'unknown'
  );
}
