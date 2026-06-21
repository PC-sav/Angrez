-- ============================================================
-- 007_plan_vocab.sql  —  Canonicalise plan vocabulary
-- ============================================================
-- Locked vocabulary: free | trial | month | year
-- 001_init.sql used 'monthly' and 'annual' in the subscriptions CHECK.
-- This migration renames those values and replaces the constraint.
--
-- ORDER IS LOAD-BEARING: drop the old constraint first, then rename
-- rows, then add the new constraint.  Reversing the order causes
-- Postgres to reject the UPDATE against the still-live old CHECK.

-- 1. Drop the old constraint so the UPDATE is unconstrained.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;

-- 2. Rename any rows already written with the old strings.
UPDATE subscriptions SET plan = 'month' WHERE plan = 'monthly';
UPDATE subscriptions SET plan = 'year'  WHERE plan = 'annual';

-- 3. Add the new constraint with the canonical vocabulary.
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('free', 'trial', 'month', 'year'));
