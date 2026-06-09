-- ============================================================
-- 001_init.sql  —  Initial Angrez schema (9 tables)
-- Applied by: npm run migrate
-- Rolled back by: npm run migrate:undo  (runs 001_init.undo.sql)
-- ============================================================

-- ── users ────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      TEXT        NOT NULL UNIQUE,
  name       TEXT,
  language   TEXT        NOT NULL DEFAULT 'hi',
  level      INT         NOT NULL DEFAULT 1,
  goal       TEXT,
  google_id  TEXT        UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── otp_codes ────────────────────────────────────────────────────────────────
-- code_hash stores bcrypt/sha256 of the OTP — the raw code is NEVER persisted.
CREATE TABLE otp_codes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT        NOT NULL,
  code_hash   TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INT         NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_otp_codes_phone ON otp_codes (phone);

-- ── content_packs ─────────────────────────────────────────────────────────────
-- One row per (stage, version, language). json holds sub-stages, puzzles, audio refs.
CREATE TABLE content_packs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stage        INT         NOT NULL,
  version      INT         NOT NULL,
  language     TEXT        NOT NULL,
  json         JSONB       NOT NULL DEFAULT '{}',
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stage, version, language)
);

-- ── progress ──────────────────────────────────────────────────────────────────
CREATE TABLE progress (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sub_stage_id  TEXT         NOT NULL,
  status        TEXT         NOT NULL DEFAULT 'not_started',
  mastery_score NUMERIC(5,2) NOT NULL DEFAULT 0,
  words_spoken  INT          NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX idx_progress_user_id ON progress (user_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER progress_set_updated_at
  BEFORE UPDATE ON progress
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── puzzle_results ────────────────────────────────────────────────────────────
CREATE TABLE puzzle_results (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  puzzle_id      TEXT        NOT NULL,
  used_voice     BOOLEAN     NOT NULL DEFAULT FALSE,
  correct        BOOLEAN     NOT NULL,
  transcript     TEXT,
  points_awarded INT         NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_puzzle_results_user_id ON puzzle_results (user_id);

-- ── wallet_ledger (APPEND-ONLY — READ THE COMMENT BELOW) ─────────────────────
--
-- THIS TABLE IS SACRED. Rules:
--   1. INSERT only. No UPDATE. No DELETE. Ever.
--   2. Balance = SUM(delta_points) for a user. NEVER add a "balance" column.
--   3. Every INSERT must carry a unique idempotency_key so double-credits are
--      impossible even if the caller retries.
--   4. reason must always describe why points changed (e.g. 'puzzle_correct',
--      'referral_bonus', 'admin_adjustment').
--   5. Rules 1–3 are enforced at the database level (triggers + unique index).
--
CREATE TABLE wallet_ledger (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  delta_points    INT         NOT NULL,
  reason          TEXT        NOT NULL,
  idempotency_key TEXT        NOT NULL UNIQUE,
  ref_id          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only enforcement: any UPDATE or DELETE raises a hard error.
CREATE OR REPLACE FUNCTION wallet_ledger_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger is append-only: % is not permitted (row id=%)',
    TG_OP, COALESCE(OLD.id::TEXT, '?')
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER wallet_ledger_no_update
  BEFORE UPDATE ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_immutable();

CREATE TRIGGER wallet_ledger_no_delete
  BEFORE DELETE ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_immutable();

-- Derived-balance view. Always query balance through here or via
--   SELECT COALESCE(SUM(delta_points),0) FROM wallet_ledger WHERE user_id=$1
-- Never store or cache a balance value outside this computation.
CREATE VIEW wallet_balances AS
  SELECT
    user_id,
    COALESCE(SUM(delta_points), 0)::INT AS balance
  FROM wallet_ledger
  GROUP BY user_id;

-- ── subscriptions ─────────────────────────────────────────────────────────────
CREATE TABLE subscriptions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan       TEXT        NOT NULL CHECK (plan IN ('free', 'trial', 'monthly', 'annual')),
  status     TEXT        NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  renews_at  TIMESTAMPTZ,
  payu_ref   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── referrals ─────────────────────────────────────────────────────────────────
CREATE TABLE referrals (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id   UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  referred_id   UUID        REFERENCES users (id) ON DELETE SET NULL,
  code          TEXT        NOT NULL,
  signup_at     TIMESTAMPTZ,
  conversion_at TIMESTAMPTZ,
  bonus_state   TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (bonus_state IN ('pending', 'signup_rewarded', 'converted', 'void')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── analytics_events ──────────────────────────────────────────────────────────
CREATE TABLE analytics_events (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        REFERENCES users (id) ON DELETE SET NULL,
  event_name TEXT        NOT NULL,
  props      JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_analytics_events_event_name ON analytics_events (event_name);
