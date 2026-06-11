-- ============================================================
-- 003_learning_loop.sql  —  Wires puzzle results to sub-stages
-- ============================================================

-- puzzle_results needs sub_stage_id so mastery can be computed per sub-stage.
-- DEFAULT '' lets the migration run even if rows exist; the application never
-- inserts without an explicit sub_stage_id.
ALTER TABLE puzzle_results
  ADD COLUMN sub_stage_id TEXT NOT NULL DEFAULT '';

ALTER TABLE puzzle_results
  ALTER COLUMN sub_stage_id DROP DEFAULT;

-- Unique constraint required for ON CONFLICT upsert in the learning service.
ALTER TABLE progress
  ADD CONSTRAINT progress_user_sub_stage_unique
  UNIQUE (user_id, sub_stage_id);
