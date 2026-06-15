-- BUG-P2-10: Add CHECK constraints for enum-like text columns
-- Prevents invalid values being inserted into columns that have a fixed set of allowed values.

ALTER TABLE ai_assistants
  ADD CONSTRAINT ai_assistants_review_notif_pref_check
  CHECK (review_notif_preference IN ('immediate', 'daily_digest', 'red_urgency_only'));

ALTER TABLE task_runs
  ADD CONSTRAINT task_runs_status_check
  CHECK (status IN ('pending', 'running', 'reviewing', 'suspended', 'completed', 'failed', 'skipped', 'terminated'));

ALTER TABLE master_assistants
  ADD CONSTRAINT master_assistants_lifecycle_check
  CHECK (lifecycle_state IN ('draft', 'review', 'beta', 'live', 'deprecated', 'archived'));

ALTER TABLE ai_model_config
  ADD CONSTRAINT ai_model_config_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'google'));

ALTER TABLE scheduled_posts
  ADD CONSTRAINT scheduled_posts_status_check
  CHECK (status IN ('draft', 'in_review', 'approved', 'scheduled', 'published', 'rejected', 'cancelled', 'missed'));
