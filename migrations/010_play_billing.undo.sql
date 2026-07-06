-- ============================================================
-- 010_play_billing.undo.sql — Drop (user_id, payu_ref) uniqueness
-- ============================================================
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_user_payu_ref_key;
COMMENT ON COLUMN subscriptions.payu_ref IS 'PayU transaction reference (populated in a later sprint).';
