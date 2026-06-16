-- ============================================================
-- 005_growth_promo.undo.sql  —  Rollback growth & promo schema
-- ============================================================

-- Drop column additions first (no dependents)
ALTER TABLE referrals DROP COLUMN IF EXISTS instant_reward_granted_at;
ALTER TABLE referrals DROP COLUMN IF EXISTS instant_reward_granted;

ALTER TABLE users DROP COLUMN IF EXISTS referral_source;
ALTER TABLE users DROP COLUMN IF EXISTS activation_completed_at;
ALTER TABLE users DROP COLUMN IF EXISTS is_founder_member;

-- Drop new tables in reverse dependency order
DROP TABLE IF EXISTS waitlist;
DROP TABLE IF EXISTS daily_first_n;
DROP TABLE IF EXISTS first_n_signups;
DROP TABLE IF EXISTS campaign_grants;
DROP TABLE IF EXISTS campaigns;
