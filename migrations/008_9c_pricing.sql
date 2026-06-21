-- ============================================================
-- 008_9c_pricing.sql  —  9C early-bird pricing infrastructure
-- ============================================================
-- Additive only.  No existing columns or constraints changed.

-- campaigns.plan: which plan an early_bird_price campaign applies to.
-- NULL for all non-pricing campaign types (bonus_points, first_n, etc.).
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS plan TEXT
  CHECK (plan IN ('trial', 'month', 'year'));

-- orders.campaign_id: the pricing campaign whose price was frozen at create-time.
-- NULL when no pricing campaign applied.  No FK — avoids RESTRICT on campaign deletes.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS campaign_id TEXT;
