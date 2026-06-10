-- ============================================================
-- 004_referrals.sql  —  Referral code + relationship capture
-- ============================================================

-- Deterministic referral code: first 12 hex chars of user id (uppercase, 48-bit).
-- GENERATED ALWAYS AS ensures the code is always consistent with the id
-- and never accidentally overwritten by application code.
ALTER TABLE users
  ADD COLUMN referral_code TEXT
  GENERATED ALWAYS AS (UPPER(LEFT(REPLACE(id::text, '-', ''), 12))) STORED;

CREATE UNIQUE INDEX users_referral_code_idx ON users(referral_code);

-- The referrals table already exists in the DB (created outside migrations).
-- Its columns: id, referrer_id, referred_id, code, signup_at, conversion_at,
--              bonus_state (= our 'status'), created_at.
-- Apply the two spec-required constraints that are missing:
--   1. referred_id NOT NULL  (spec: referee is known at capture time)
--   2. UNIQUE(referred_id)   (spec: one referral per referee, ever)
ALTER TABLE referrals ALTER COLUMN referred_id SET NOT NULL;
ALTER TABLE referrals ADD CONSTRAINT referrals_referred_id_unique UNIQUE (referred_id);
