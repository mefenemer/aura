-- US-DB-1.4.1: Least-privilege application role for Row-Level Security.
--
-- The app currently connects as `neondb_owner` (the table owner), which BYPASSES RLS.
-- RLS only takes effect for a role that is NOT the table owner and lacks BYPASSRLS.
-- This script provisions that role. Run it ONCE against the database (Neon SQL editor
-- or psql) as an admin/owner role. Idempotent — safe to re-run.
--
-- After running:
--   1. Set a strong password below (replace CHANGE_ME).
--   2. Put the app_user connection string in APP_DATABASE_URL (Netlify env + local .env),
--      same host/database as NETLIFY_DATABASE_URL but user=app_user.
--   3. Apply db/rls/R1-crown-jewels.sql to enable the policies.
--
-- IMPORTANT: test against a Neon *branch* database before production.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE ROLE app_user LOGIN PASSWORD 'CHANGE_ME';
    END IF;
END;
$$;

-- Never allow the app role to bypass RLS, and ensure it does not own objects.
ALTER ROLE app_user NOBYPASSRLS;

-- Schema + existing objects
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;

-- Future objects created by the owner are granted automatically
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_user;

-- Re-assert the append-only audit guarantees for app_user (see db/audit-log-immutability.sql).
-- These tables must never be UPDATE/DELETE-able by the application role.
REVOKE UPDATE, DELETE ON admin_audit_log   FROM app_user;
REVOKE UPDATE, DELETE ON audit_logs         FROM app_user;
REVOKE UPDATE, DELETE ON dpa_acceptances    FROM app_user;
REVOKE UPDATE, DELETE ON gdpr_erasure_log   FROM app_user;
