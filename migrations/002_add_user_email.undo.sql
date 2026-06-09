-- ============================================================
-- 002_add_user_email.undo.sql
-- ============================================================

ALTER TABLE users DROP COLUMN IF EXISTS email;
ALTER TABLE users ALTER COLUMN phone SET NOT NULL;
