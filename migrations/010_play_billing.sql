-- ============================================================
-- 010_play_billing.sql — Unique (user_id, payu_ref) for GPB entitlement writes
-- ============================================================
-- payu_ref has been an unwritten placeholder since 001_init.sql (SCHEMA.md
-- called it "the PayU transaction reference, populated in a later sprint" —
-- that sprint never came; no code has ever written to it, Cashfree included).
-- It is hereby repurposed as the idempotency/reference key for
-- server-verified subscription grants: the Google Play purchase token for
-- GPB rows (D1c).  Cashfree rows continue to leave it NULL.
--
-- The constraint is the DB-level idempotency guard for RTDN redelivery — the
-- Play webhook handler's INSERT ... ON CONFLICT (user_id, payu_ref) DO UPDATE
-- relies on it to converge repeated notifications for the same purchase
-- token onto one row.  Postgres treats NULL as distinct from NULL under a
-- plain UNIQUE constraint, so existing/Cashfree rows (payu_ref IS NULL) are
-- unaffected — multiple NULL rows per user remain legal.

-- Guard: verify no existing duplicate (user_id, payu_ref) pairs before adding
-- the constraint.  Expected to be a no-op (payu_ref is confirmed unwritten
-- today) but the migration must verify, not assume.
DO $$
DECLARE
  dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT user_id, payu_ref
    FROM subscriptions
    WHERE payu_ref IS NOT NULL
    GROUP BY user_id, payu_ref
    HAVING COUNT(*) > 1
  ) dups;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add unique (user_id, payu_ref) constraint: % duplicate pair(s) already exist',
      dup_count;
  END IF;
END $$;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_user_payu_ref_key UNIQUE (user_id, payu_ref);

COMMENT ON COLUMN subscriptions.payu_ref IS
  'Idempotency/reference key for server-verified grants. Google Play Billing (D1c): the purchase token. Cashfree-sourced rows: NULL. Do not rename without updating the Play webhook upsert (unique constraint subscriptions_user_payu_ref_key).';
