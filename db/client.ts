// src/db/client.ts
import { config } from 'dotenv';
import * as path from 'path';
import { sql as sqlExpr } from 'drizzle-orm';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// Ensure environment variables are loaded relative to runtime workspace execution
config({ path: path.resolve(process.cwd(), '.env') });

let sql: postgres.Sql | null = null;
let db: PostgresJsDatabase<Record<string, never>> | null = null;

export const withUpdatedAt = <T extends Record<string, unknown>>(set: T): T & { updatedAt: Date } =>
    ({ ...set, updatedAt: new Date() });

export function getDb() {
    if (!db) {
        const connectionString = process.env.NETLIFY_DATABASE_URL;
        if (!connectionString) {
            throw new Error("CRITICAL: NETLIFY_DATABASE_URL is missing from environment variables.");
        }
        // Cache connections globally across serverless function invocations
        // BUG-P1-6: Add timeouts to prevent silent serverless hangs on unreachable DB.
        // connect_timeout: fail fast on cold-start; idle_timeout: release stale TCP sockets;
        // max_lifetime: rotate connections to avoid accumulated stale state.
        sql = postgres(connectionString, {
            max: 1,
            connect_timeout: 5,   // seconds — abort if DB unreachable within 5s
            idle_timeout: 20,     // seconds — release idle connections between invocations
            max_lifetime: 60 * 5, // seconds — rotate connections every 5 minutes
        });
        db = drizzle({ client: sql });
    }
    return db;
}

/**
 * US-DB-1.3.1 (RLS foundation — defense-in-depth, not yet enforced).
 *
 * Runs `fn` inside a transaction that sets the per-request tenant GUC
 * `app.current_org` (transaction-scoped via set_config(..., is_local=true)).
 * This is the connection-safe way to scope Postgres Row-Level Security on this
 * stack: `postgres-js` here keeps a single cached connection (max: 1), so only
 * transaction-local settings are safe under concurrent invocations — a
 * session-level `SET` would leak across requests sharing the connection.
 *
 * Enablement path (the remaining, breaking step — do in a dedicated change):
 *   1. Add RLS policies to every tenant table:
 *        ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
 *        CREATE POLICY tenant_isolation ON <t>
 *          USING (organisation_id = current_setting('app.current_org')::int);
 *   2. Route ALL tenant queries through withTenant(orgId, ...). Any query that
 *      doesn't set the GUC will see zero rows once policies are enforced, so the
 *      routing must be complete before the policies are applied.
 *
 * Until both steps land, the application-layer guard in src/utils/tenant.ts is
 * the active tenant boundary and this helper is unused infrastructure.
 */
export async function withTenant<T>(orgId: number, fn: (tx: PostgresJsDatabase<Record<string, never>>) => Promise<T>): Promise<T> {
    if (!Number.isInteger(orgId) || orgId <= 0) {
        throw new Error('withTenant requires a valid positive organisation id.');
    }
    return getDb().transaction(async (tx) => {
        await tx.execute(sqlExpr`SELECT set_config('app.current_org', ${String(orgId)}, true)`);
        return fn(tx);
    });
}