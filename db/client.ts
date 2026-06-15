// src/db/client.ts
import { config } from 'dotenv';
import * as path from 'path';
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