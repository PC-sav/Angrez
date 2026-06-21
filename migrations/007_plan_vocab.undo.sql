-- ============================================================
-- 007_plan_vocab.undo.sql  —  Rollback plan vocabulary fix
-- ============================================================

UPDATE subscriptions SET plan = 'monthly' WHERE plan = 'month';
UPDATE subscriptions SET plan = 'annual'  WHERE plan = 'year';

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('free', 'trial', 'monthly', 'annual'));
