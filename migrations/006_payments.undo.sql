-- ============================================================
-- 006_payments.undo.sql  —  Rollback Cashfree orders table
-- ============================================================

DROP INDEX IF EXISTS idx_orders_user_id;
DROP TABLE IF EXISTS orders;
