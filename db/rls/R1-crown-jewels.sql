-- US-DB-1.4.1: RLS enforcement — Phase R1 (crown-jewel tables).
--
-- Enables Row-Level Security + a fail-closed tenant-isolation policy on the most
-- sensitive tenant tables. Run AFTER db/rls/00-app-user-role.sql and AFTER deploying
-- the code that routes those tables' queries through withTenant() (which connects as
-- app_user and sets app.current_org).
--
-- Safety:
--   * ENABLE (not FORCE): the owner connection (neondb_owner / getDb()) keeps bypassing
--     RLS, so cron/admin/webhook jobs and any not-yet-migrated function are unaffected.
--   * current_setting('app.current_org', true) returns NULL when unset → the predicate
--     matches no rows → FAIL CLOSED (no accidental cross-tenant reads if context is missing).
--   * Reversible per table: ALTER TABLE <t> DISABLE ROW LEVEL SECURITY.
--
-- Idempotent — safe to re-run.

-- R1 enables enforcement only for tables whose user-facing functions are already
-- routed through withTenant (currently the ai_assistants function set). Additional
-- crown jewels (workspace_assets, content_assets, payments, invoices, plans) are added
-- here as their functions are wrapped in subsequent slices — enabling a policy before
-- its callers are wrapped is harmless (those callers stay on the owner/bypass path) but
-- provides no protection, so we keep policy and wrapping in lockstep.
DO $$
DECLARE
    t text;
    crown_jewels text[] := ARRAY[
        'ai_assistants'
    ];
BEGIN
    FOREACH t IN ARRAY crown_jewels LOOP
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = t) THEN

            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

            -- Drop+recreate so the policy definition stays in sync on re-run.
            EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
            EXECUTE format($f$
                CREATE POLICY tenant_isolation ON public.%I
                    USING      (organisation_id = current_setting('app.current_org', true)::int)
                    WITH CHECK (organisation_id = current_setting('app.current_org', true)::int)
            $f$, t);
        END IF;
    END LOOP;
END;
$$;
