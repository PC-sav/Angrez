-- ============================================================
-- 005_growth_promo.sql  —  Growth & Promo infrastructure
-- ============================================================
-- Additive only: 5 new tables + 5 new columns on existing tables.
-- Zero changes to existing columns, constraints, or indexes.

-- ── New tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaigns (
  id              TEXT        PRIMARY KEY,
  name            TEXT        NOT NULL,
  type            TEXT        NOT NULL,            -- 'bonus_points' | 'streak_freeze' | 'first_n' | 'daily_first_n' | 'early_bird'
  active          BOOLEAN     NOT NULL DEFAULT false,
  quota           INTEGER,
  granted_count   INTEGER     NOT NULL DEFAULT 0,
  daily_quota     INTEGER,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  award_points    INTEGER     NOT NULL DEFAULT 0,
  price_paise     INTEGER,
  eligibility_json TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaign_grants (
  id              BIGSERIAL   PRIMARY KEY,
  idempotency_key TEXT        UNIQUE NOT NULL,
  campaign_id     TEXT        NOT NULL REFERENCES campaigns(id),
  user_id         UUID        NOT NULL REFERENCES users(id),
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  award_points    INTEGER     NOT NULL
);

CREATE TABLE IF NOT EXISTS first_n_signups (
  user_id         UUID        PRIMARY KEY REFERENCES users(id),
  signup_rank     BIGINT      NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_first_n (
  id              BIGSERIAL   PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES users(id),
  campaign_id     TEXT        NOT NULL REFERENCES campaigns(id),
  day             DATE        NOT NULL,
  rank            INTEGER     NOT NULL,
  UNIQUE (campaign_id, day, rank)
);

CREATE TABLE IF NOT EXISTS waitlist (
  id              BIGSERIAL   PRIMARY KEY,
  phone           TEXT        UNIQUE,
  email           TEXT        UNIQUE,
  name            TEXT,
  referral_code   TEXT,
  position        INTEGER,
  claimed         BOOLEAN     NOT NULL DEFAULT false,
  claimed_at      TIMESTAMPTZ,
  claimed_user_id UUID        REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Column additions to existing tables ──────────────────────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_founder_member        BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activation_completed_at  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_source          TEXT;

ALTER TABLE referrals ADD COLUMN IF NOT EXISTS instant_reward_granted     BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS instant_reward_granted_at  TIMESTAMPTZ;
