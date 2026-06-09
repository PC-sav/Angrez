-- ============================================================
-- 001_init.undo.sql  —  Roll back the initial Angrez schema
-- Applied by: npm run migrate:undo
-- WARNING: drops all data in all nine Angrez tables.
-- ============================================================

DROP VIEW     IF EXISTS wallet_balances;

DROP TRIGGER  IF EXISTS wallet_ledger_no_delete     ON wallet_ledger;
DROP TRIGGER  IF EXISTS wallet_ledger_no_update     ON wallet_ledger;
DROP FUNCTION IF EXISTS wallet_ledger_immutable();

DROP TRIGGER  IF EXISTS progress_set_updated_at     ON progress;
DROP FUNCTION IF EXISTS set_updated_at();

-- Drop in reverse FK order so no constraint violations occur.
DROP TABLE IF EXISTS analytics_events;
DROP TABLE IF EXISTS referrals;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS wallet_ledger;
DROP TABLE IF EXISTS puzzle_results;
DROP TABLE IF EXISTS progress;
DROP TABLE IF EXISTS content_packs;
DROP TABLE IF EXISTS otp_codes;
DROP TABLE IF EXISTS users;
