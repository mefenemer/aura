-- Issue Reports (Testing-phase bug reporting) — user-submitted issues + admin triage.
--
-- While the product is in the testing phase, the workspace exposes a "Report an Issue"
-- side-menu item. Each submission captures: a free-text description, the location the
-- user was on when they hit the button (source_location/source_url — tells the developer
-- WHERE the issue was), and an optional screenshot (stored inline as a base64 data URL so
-- the feature works without S3/R2 being provisioned). Issues are stored against the user
-- so they can track progress; the admin owner is emailed on every new report.
--
-- Lifecycle (status): reported → fix_in_progress → fixed_ready_to_test → closed
--                     ↘ more_info_required (admin asks the user for detail) ↗
-- The threaded back-and-forth (admin status messages + user replies) lives in
-- issue_report_messages.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS issue_reports (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  description      TEXT NOT NULL,                       -- what the user reported
  source_location  TEXT,                                -- in-app view/route the user came from (e.g. 'calendar')
  source_url       TEXT,                                -- full URL at time of report
  user_agent       TEXT,                                -- browser UA, aids reproduction

  -- Optional screenshot. Stored inline as a data URL (data:image/png;base64,...) so the
  -- feature has no hard dependency on object storage during the testing phase.
  image_data       TEXT,
  image_mime       TEXT,

  -- reported | fix_in_progress | fixed_ready_to_test | more_info_required | closed
  status           TEXT NOT NULL DEFAULT 'reported',

  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMP                            -- set when the user confirms the fix (status=closed)
);

-- "My reports" for a user; and tenant-scoped admin/cleanup lookups.
CREATE INDEX IF NOT EXISTS issue_reports_user_idx   ON issue_reports (user_id, created_at);
CREATE INDEX IF NOT EXISTS issue_reports_org_idx    ON issue_reports (organisation_id);
CREATE INDEX IF NOT EXISTS issue_reports_status_idx ON issue_reports (status, created_at);

-- Constrain status to the known set (idempotent add).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'issue_reports_status_check'
  ) THEN
    ALTER TABLE issue_reports
      ADD CONSTRAINT issue_reports_status_check
      CHECK (status IN ('reported', 'fix_in_progress', 'fixed_ready_to_test', 'more_info_required', 'closed'));
  END IF;
END $$;

-- Threaded conversation: admin status updates / supporting messages, and user replies
-- (e.g. answering a "More info required" request, or confirming a fix).
CREATE TABLE IF NOT EXISTS issue_report_messages (
  id          SERIAL PRIMARY KEY,
  issue_id    INTEGER NOT NULL REFERENCES issue_reports(id) ON DELETE CASCADE,
  -- 'admin' | 'user' — who wrote this message
  author_type TEXT NOT NULL,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  -- The status the issue was moved to alongside this message (null = plain message/reply).
  status      TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS issue_report_messages_issue_idx
  ON issue_report_messages (issue_id, created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'issue_report_messages_author_check'
  ) THEN
    ALTER TABLE issue_report_messages
      ADD CONSTRAINT issue_report_messages_author_check
      CHECK (author_type IN ('admin', 'user'));
  END IF;
END $$;
