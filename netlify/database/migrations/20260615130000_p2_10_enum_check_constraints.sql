-- BUG-P2-10: Add CHECK constraints for enum-like text columns
-- Prevents invalid values being inserted into columns that have a fixed set of allowed values.
-- Each block guards against tables/columns that may not yet exist in fresh branch databases.

-- ai_assistants: ensure review_notif_preference column exists, then add CHECK
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_assistants') THEN
    ALTER TABLE ai_assistants
      ADD COLUMN IF NOT EXISTS review_notif_preference text NOT NULL DEFAULT 'immediate';
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'ai_assistants_review_notif_pref_check' AND table_name = 'ai_assistants'
    ) THEN
      ALTER TABLE ai_assistants
        ADD CONSTRAINT ai_assistants_review_notif_pref_check
        CHECK (review_notif_preference IN ('immediate', 'daily_digest', 'red_urgency_only'));
    END IF;
  END IF;
END;
$$;

-- task_runs
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'task_runs') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'task_runs_status_check' AND table_name = 'task_runs'
    ) THEN
      ALTER TABLE task_runs
        ADD CONSTRAINT task_runs_status_check
        CHECK (status IN ('pending', 'running', 'reviewing', 'suspended', 'completed', 'failed', 'skipped', 'terminated'));
    END IF;
  END IF;
END;
$$;

-- master_assistants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'master_assistants') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'master_assistants_lifecycle_check' AND table_name = 'master_assistants'
    ) THEN
      ALTER TABLE master_assistants
        ADD CONSTRAINT master_assistants_lifecycle_check
        CHECK (lifecycle_state IN ('draft', 'review', 'beta', 'live', 'deprecated', 'archived'));
    END IF;
  END IF;
END;
$$;

-- ai_model_config
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_model_config') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'ai_model_config_provider_check' AND table_name = 'ai_model_config'
    ) THEN
      ALTER TABLE ai_model_config
        ADD CONSTRAINT ai_model_config_provider_check
        CHECK (provider IN ('openai', 'anthropic', 'google'));
    END IF;
  END IF;
END;
$$;

-- scheduled_posts
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'scheduled_posts') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'scheduled_posts_status_check' AND table_name = 'scheduled_posts'
    ) THEN
      ALTER TABLE scheduled_posts
        ADD CONSTRAINT scheduled_posts_status_check
        CHECK (status IN ('draft', 'in_review', 'approved', 'scheduled', 'published', 'rejected', 'cancelled', 'missed'));
    END IF;
  END IF;
END;
$$;
