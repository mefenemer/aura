-- US-DB-1.6.1: Append-only enforcement for legally-admissible audit tables.
-- Apply once after db:push. These DDL statements cannot be expressed in Drizzle schema.
--
-- Tables covered: admin_audit_log, audit_logs, dpa_acceptances, gdpr_erasure_log
-- Control: SOC 2 CC7.x — evidences that audit records cannot be modified or deleted by any party.

-- Step 1: Revoke UPDATE and DELETE from the application role
REVOKE UPDATE, DELETE ON admin_audit_log FROM app_user;
REVOKE UPDATE, DELETE ON audit_logs FROM app_user;
REVOKE UPDATE, DELETE ON dpa_acceptances FROM app_user;
REVOKE UPDATE, DELETE ON gdpr_erasure_log FROM app_user;

-- Step 2: Create the guard function (shared by all triggers)
CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Mutation of immutable audit table "%" is not permitted.', TG_TABLE_NAME;
END;
$$;

-- Step 3: Attach BEFORE UPDATE OR DELETE triggers to each audit table
CREATE TRIGGER admin_audit_log_immutable
    BEFORE UPDATE OR DELETE ON admin_audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_logs_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER dpa_acceptances_immutable
    BEFORE UPDATE OR DELETE ON dpa_acceptances
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER gdpr_erasure_log_immutable
    BEFORE UPDATE OR DELETE ON gdpr_erasure_log
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
