-- ============================================================
-- 009_completed_at.sql  —  Add completed_at to progress table
-- ============================================================
-- completed_at records the FIRST time a sub-stage was mastered.
-- Unlike updated_at (trigger-maintained, refreshed on every DO UPDATE
-- touch), completed_at is written on INSERT and protected by
-- COALESCE(progress.completed_at, now()) on conflict — so re-mastery
-- of an already-complete sub-stage never overwrites the original date.
-- This gives a stable timestamp for the free-tier daily-limit gate.

ALTER TABLE progress ADD COLUMN completed_at TIMESTAMPTZ;

-- Backfill: use updated_at as the best available approximation for
-- historical completions.  Non-complete rows are left NULL — they
-- have no completion event and must not count toward the daily limit.
UPDATE progress
SET    completed_at = updated_at
WHERE  status = 'complete'
  AND  completed_at IS NULL;
