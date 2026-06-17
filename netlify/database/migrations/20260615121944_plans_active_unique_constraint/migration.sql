-- BUG-P0-4: Replace plain index with partial unique index to enforce one active/past_due plan per org.
-- A plain index() in Drizzle only creates a B-tree index; it does NOT enforce uniqueness.
-- Two concurrent checkout completions could previously insert two active plans for the same org.

DROP INDEX IF EXISTS "plans_one_active_per_org";

CREATE UNIQUE INDEX "plans_one_active_per_org_unique"
    ON "plans" ("organisation_id")
    WHERE status IN ('active', 'past_due');
