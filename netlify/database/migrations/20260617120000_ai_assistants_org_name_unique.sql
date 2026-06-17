-- US-DB-1.3.1: AI assistants become org-owned & member-shared.
-- Move the uniqueness of assistant names from (user_id, name) to (organisation_id, name).
--
-- Before the new constraint can be added, any pre-existing duplicate names within the
-- same organisation (possible under the old per-user model when two members each created
-- an assistant with the same name) must be made unique. We keep the lowest-id row as-is
-- and suffix the rest with their id. Idempotent and safe to re-run.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_assistants') THEN

    -- 1. De-duplicate same-name assistants within an organisation (keep lowest id unchanged).
    UPDATE ai_assistants a
    SET name = a.name || ' (#' || a.id || ')',
        updated_at = now()
    WHERE EXISTS (
      SELECT 1 FROM ai_assistants b
      WHERE b.organisation_id = a.organisation_id
        AND b.name = a.name
        AND b.id < a.id
    );

    -- 2. Drop the old per-user uniqueness constraint if present.
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'ai_assistants_user_name_unique' AND table_name = 'ai_assistants'
    ) THEN
      ALTER TABLE ai_assistants DROP CONSTRAINT ai_assistants_user_name_unique;
    END IF;

    -- 3. Add the new per-organisation uniqueness constraint if not already present.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'ai_assistants_org_name_unique' AND table_name = 'ai_assistants'
    ) THEN
      ALTER TABLE ai_assistants
        ADD CONSTRAINT ai_assistants_org_name_unique UNIQUE (organisation_id, name);
    END IF;

  END IF;
END;
$$;
