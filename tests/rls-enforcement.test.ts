// tests/rls-enforcement.test.ts
// US-DB-1.4.1: proves Row-Level Security actually isolates tenants at the database
// layer for the crown-jewel table ai_assistants — independent of any application WHERE.
//
// Run:  npx tsx tests/rls-enforcement.test.ts
//
// Requires BOTH:
//   * NETLIFY_DATABASE_URL — owner role, used to seed + clean up test rows
//   * APP_DATABASE_URL     — app_user role (non-owner, subject to RLS), the role under test
// Skips gracefully if APP_DATABASE_URL is absent (role not provisioned yet).
//
// IMPORTANT: run this against a NEON BRANCH database, not production. It creates and
// then deletes two throwaway orgs/users/assistants (all prefixed RLS_TEST_).

import { config } from 'dotenv';
import * as path from 'path';
import assert from 'node:assert';
import postgres from 'postgres';

config({ path: path.resolve(process.cwd(), '.env') });

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

(async () => {
    const ownerUrl = process.env.NETLIFY_DATABASE_URL;
    const appUrl = process.env.APP_DATABASE_URL;

    console.log('US-DB-1.4.1 — RLS enforcement (ai_assistants)');
    if (!ownerUrl) { console.log('  ⊘ skipped — NETLIFY_DATABASE_URL not set'); return; }
    if (!appUrl)   { console.log('  ⊘ skipped — APP_DATABASE_URL not set (app_user role not provisioned yet)'); return; }

    const owner = postgres(ownerUrl, { max: 1 });
    const app = postgres(appUrl, { max: 1 });
    const tag = `RLS_TEST_${Date.now()}`;
    let orgA = 0, orgB = 0;

    try {
        // ── Seed two tenants (as owner; committed so the app_user connection can see them) ──
        [{ id: orgA }] = await owner`INSERT INTO organisations (name, slug) VALUES (${tag + '_A'}, ${tag + '-a'}) RETURNING id`;
        [{ id: orgB }] = await owner`INSERT INTO organisations (name, slug) VALUES (${tag + '_B'}, ${tag + '-b'}) RETURNING id`;
        const [{ id: userA }] = await owner`INSERT INTO users (email, status) VALUES (${tag + '_a@example.test'}, 'active') RETURNING id`;
        const [{ id: userB }] = await owner`INSERT INTO users (email, status) VALUES (${tag + '_b@example.test'}, 'active') RETURNING id`;
        await owner`INSERT INTO ai_assistants (user_id, organisation_id, name, model) VALUES (${userA}, ${orgA}, ${tag + '_botA'}, 'gpt-4o')`;
        await owner`INSERT INTO ai_assistants (user_id, organisation_id, name, model) VALUES (${userB}, ${orgB}, ${tag + '_botB'}, 'gpt-4o')`;

        // Helper: run a query as app_user with app.current_org set to `org` (transaction-local).
        const asTenant = <T>(org: number, q: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> =>
            app.begin(async (sql) => {
                await sql`SELECT set_config('app.current_org', ${String(org)}, true)`;
                return q(sql);
            }) as Promise<T>;

        // ── Sanity: the owner connection bypasses RLS and sees both rows ──
        await check('owner (bypass) sees both tenants\' assistants', async () => {
            const rows = await owner`SELECT organisation_id FROM ai_assistants WHERE name IN (${tag + '_botA'}, ${tag + '_botB'})`;
            assert.strictEqual(rows.length, 2, `owner should see 2, saw ${rows.length}`);
        });

        // ── Core: app_user scoped to org A sees ONLY org A ──
        await check('app_user @ org A sees its own assistant', async () => {
            const rows = await asTenant(orgA, (sql) => sql`SELECT name FROM ai_assistants WHERE name LIKE ${tag + '%'}`);
            assert.strictEqual(rows.length, 1, `expected 1 row, got ${rows.length}`);
            assert.strictEqual(rows[0].name, tag + '_botA');
        });

        await check('app_user @ org A CANNOT see org B\'s assistant', async () => {
            const rows = await asTenant(orgA, (sql) => sql`SELECT id FROM ai_assistants WHERE organisation_id = ${orgB}`);
            assert.strictEqual(rows.length, 0, 'RLS must hide org B rows from an org A context');
        });

        // ── Write isolation: cannot mutate another tenant's row, nor insert into it ──
        await check('app_user @ org A CANNOT update org B\'s assistant', async () => {
            const updated = await asTenant(orgA, (sql) =>
                sql`UPDATE ai_assistants SET name = 'hijacked' WHERE organisation_id = ${orgB} RETURNING id`);
            assert.strictEqual(updated.length, 0, 'USING clause must make org B rows invisible to UPDATE');
            // Confirm org B's row is untouched (checked as owner).
            const [b] = await owner`SELECT name FROM ai_assistants WHERE organisation_id = ${orgB} AND name LIKE ${tag + '%'}`;
            assert.strictEqual(b.name, tag + '_botB', 'org B row must be unchanged');
        });

        await check('app_user @ org A CANNOT insert a row for org B (WITH CHECK)', async () => {
            await assert.rejects(
                asTenant(orgA, (sql) =>
                    sql`INSERT INTO ai_assistants (user_id, organisation_id, name, model)
                        SELECT user_id, ${orgB}, ${tag + '_evil'}, 'gpt-4o' FROM ai_assistants WHERE organisation_id = ${orgA} LIMIT 1`),
                'WITH CHECK must reject inserting a row owned by a different org',
            );
        });

        // ── Fail-closed: no org context set → no rows ──
        await check('app_user with NO org context sees nothing (fail-closed)', async () => {
            const rows = await app`SELECT id FROM ai_assistants WHERE name LIKE ${tag + '%'}`;
            assert.strictEqual(rows.length, 0, 'missing app.current_org must match no rows');
        });

        console.log(`\n${passed} checks passed`);
    } finally {
        // Cleanup (as owner). organisations cascade to ai_assistants; remove users explicitly.
        if (orgA) await owner`DELETE FROM organisations WHERE id IN (${orgA}, ${orgB})`.catch(() => {});
        await owner`DELETE FROM users WHERE email LIKE ${tag + '%'}`.catch(() => {});
        await app.end();
        await owner.end();
    }
})();
