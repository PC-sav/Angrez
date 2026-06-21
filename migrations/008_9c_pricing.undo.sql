-- ============================================================
-- 008_9c_pricing.undo.sql  —  Rollback 9C pricing columns
-- ============================================================

ALTER TABLE orders     DROP COLUMN IF EXISTS campaign_id;
ALTER TABLE campaigns  DROP COLUMN IF EXISTS plan;
