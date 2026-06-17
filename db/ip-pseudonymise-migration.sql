-- US-GDPR-3.2.2: One-off migration to pseudonymise raw IP addresses already stored in audit tables.
-- Truncates IPv4 to /24 subnet (last octet replaced with 'x').
-- Idempotent: rows already in 'N.N.N.x' format or NULL are left unchanged.
-- Apply once against the production database after deploying the application changes.

-- audit_logs
UPDATE audit_logs
SET ip_address = regexp_replace(ip_address, '^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$', '\1.x')
WHERE ip_address IS NOT NULL
  AND ip_address !~ '^(\d{1,3}\.\d{1,3}\.\d{1,3})\.x$'
  AND ip_address ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$';

-- admin_audit_log
UPDATE admin_audit_log
SET ip_address = regexp_replace(ip_address, '^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$', '\1.x')
WHERE ip_address IS NOT NULL
  AND ip_address !~ '^(\d{1,3}\.\d{1,3}\.\d{1,3})\.x$'
  AND ip_address ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$';
