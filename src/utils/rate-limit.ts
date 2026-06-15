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

import { gte, and, eq, count, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
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
 * BUG-P1-4: The old count-then-insert pattern had a TOCTOU race: two concurrent
 * requests could both read count < maxAttempts, both insert, and both be allowed —
 * effectively doubling the limit. Fixed by wrapping in a transaction with a PostgreSQL
 * advisory lock so the count+insert is atomic per (key, endpoint) pair.
 *
 * @param db          Drizzle DB instance
 * @param endpoint    Short endpoint identifier ('register' | 'login' | 'onboarding' | 'support')
 * @param key         IP address or 'user:<userId>' string
 * @param opts        { maxAttempts, windowSecs }
 */
export async function checkRateLimit(
  db: PostgresJsDatabase<any>,
  endpoint: string,
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const { maxAttempts, windowSecs } = opts;
  const windowStart = new Date(Date.now() - windowSecs * 1000);

  let allowed = false;

  await db.transaction(async (tx: any) => {
    // Acquire a session-level advisory lock keyed on (endpoint, key).
    // pg_advisory_xact_lock blocks until acquired and is released at transaction end.
    // This serialises concurrent requests for the same key+endpoint, making the
    // count+insert atomic and eliminating the TOCTOU window.
    const lockKey = `${endpoint}:${key}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const [{ value: existingCount }] = await tx
      .select({ value: count() })
      .from(rateLimitAttempts)
      .where(and(
        eq(rateLimitAttempts.key, key),
        eq(rateLimitAttempts.endpoint, endpoint),
        gte(rateLimitAttempts.attemptedAt, windowStart),
      ));

    if (existingCount >= maxAttempts) {
      allowed = false;
      return;
    }

    await tx.insert(rateLimitAttempts).values({ key, endpoint });
    allowed = true;
  });

  if (!allowed) {
    return { allowed: false, retryAfterSecs: windowSecs };
  }

  // Prune stale rows outside transaction (non-blocking — pruning failure must never block requests)
  const pruneThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
  db
    .delete(rateLimitAttempts)
    .where(and(
      eq(rateLimitAttempts.key, key),
      eq(rateLimitAttempts.endpoint, endpoint),
      lt(rateLimitAttempts.attemptedAt, pruneThreshold),
    ))
    .catch(() => {});

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
