-- ============================================================
-- 007_plan_vocab.undo.sql  —  Rollback plan vocabulary fix
-- ============================================================

-- 1. Drop the new constraint first.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;

-- 2. Restore old string values.
UPDATE subscriptions SET plan = 'monthly' WHERE plan = 'month';
UPDATE subscriptions SET plan = 'annual'  WHERE plan = 'year';

-- 3. Re-add the original constraint.
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('free', 'trial', 'monthly', 'annual'));
