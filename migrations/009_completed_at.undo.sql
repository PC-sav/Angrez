-- ============================================================
-- 009_completed_at.undo.sql  —  Remove completed_at column
-- ============================================================
ALTER TABLE progress DROP COLUMN IF EXISTS completed_at;
