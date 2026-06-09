-- ============================================================
-- 002_add_user_email.sql
-- Add email column and make phone nullable for Google auth users.
-- ============================================================

-- Google auth users arrive without a phone; allow NULL.
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;

-- Store email for Google auth (nullable for OTP-only users).
ALTER TABLE users ADD COLUMN email TEXT UNIQUE;
