// src/db/client.ts
import { config } from 'dotenv';
import * as path from 'path';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// Ensure environment variables are loaded relative to runtime workspace execution
config({ path: path.resolve(process.cwd(), '.env') });

let sql: postgres.Sql | null = null;
let db: PostgresJsDatabase<Record<string, never>> | null = null;

export function getDb() {
    if (!db) {
        const connectionString = process.env.NETLIFY_DATABASE_URL;
        if (!connectionString) {
            throw new Error("CRITICAL: NETLIFY_DATABASE_URL is missing from environment variables.");
        }
        // Cache connections globally across serverless function invocations
        sql = postgres(connectionString, { max: 1 });
        db = drizzle({ client: sql });
    }
    return db;
}