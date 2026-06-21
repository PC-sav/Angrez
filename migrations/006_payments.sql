-- ============================================================
-- 006_payments.sql  —  Cashfree payment orders table
-- ============================================================
-- The subscriptions table already exists (001_init.sql) and tracks
-- plan/status/renews_at.  This migration adds only the orders table
-- needed for server-authoritative payment tracking.
--
-- orders.plan uses the client-facing IDs ('trial'|'month'|'year').
-- The webhook handler maps these to DB plan values before writing
-- to subscriptions ('trial'|'monthly'|'annual').
--
-- orders.amount is in major currency units (rupees), matching the
-- Cashfree order_amount field (not paise).

CREATE TABLE IF NOT EXISTS orders (
  order_id    TEXT        PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users(id),
  plan        TEXT        NOT NULL CHECK (plan IN ('trial', 'month', 'year')),
  amount      INT         NOT NULL,
  currency    TEXT        NOT NULL DEFAULT 'INR',
  status      TEXT        NOT NULL DEFAULT 'CREATED'
                CHECK (status IN ('CREATED', 'PAID', 'FAILED', 'DROPPED')),
  cf_order_id TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_user_id ON orders(user_id);
