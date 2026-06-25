-- "Create Post" → Suggest an idea mode.
--
-- A user-submitted post idea (suggest-post-idea.ts) that the assistant should weave into a FUTURE
-- scheduled/conversion draft — it is NOT drafted immediately. Consumed once, FIFO: when
-- process-content-jobs.ts picks up a scheduled/conversion job that carries no context_prompt, it
-- pulls the oldest 'pending' idea for that assistant, uses the idea text as the generation context,
-- and on success marks the row 'used' (used_post_id = the resulting draft, used_at = now()).
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can
-- propose DISABLE ROW LEVEL SECURITY / DROP POLICY on the RLS-enabled tables.
-- Canonical column definitions live in db/schema.ts (export const postIdeaSuggestions).
-- Idempotent — safe to re-run.
--
-- RLS: intentionally NOT enabled here. Reads/writes go through getDb() (the neondb_owner
-- connection, which bypasses RLS) and filter by organisation_id explicitly — the same
-- owner-path + manual-filter pattern as content_rules / scheduled_posts / post_insights.

CREATE TABLE IF NOT EXISTS post_idea_suggestions (
  id              SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  assistant_id    INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea            TEXT NOT NULL,
  platform        TEXT,                              -- optional hint: facebook|instagram|linkedin|x
  status          TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'used' | 'discarded'
  used_post_id    INTEGER REFERENCES scheduled_posts(id) ON DELETE SET NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  used_at         TIMESTAMP
);

-- FIFO lookup of the next pending idea for an assistant.
CREATE INDEX IF NOT EXISTS post_idea_suggestions_assistant_status_idx
  ON post_idea_suggestions (assistant_id, status);

-- Constrain status to the known lifecycle values (idempotent add).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'post_idea_suggestions_status_check'
  ) THEN
    ALTER TABLE post_idea_suggestions
      ADD CONSTRAINT post_idea_suggestions_status_check CHECK (status IN ('pending', 'used', 'discarded'));
  END IF;
END $$;
