-- ============================================================
-- 007_plan_vocab.sql  —  Canonicalise plan vocabulary
-- ============================================================
-- Locked vocabulary: free | trial | month | year
-- 001_init.sql used 'monthly' and 'annual' in the subscriptions CHECK.
-- This migration renames those values and replaces the constraint.

-- Fix any rows already written with the old strings.
UPDATE subscriptions SET plan = 'month' WHERE plan = 'monthly';
UPDATE subscriptions SET plan = 'year'  WHERE plan = 'annual';

-- Replace the CHECK constraint.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('free', 'trial', 'month', 'year'));
