ALTER TABLE referrals DROP CONSTRAINT IF EXISTS referrals_referred_id_unique;
ALTER TABLE referrals ALTER COLUMN referred_id DROP NOT NULL;
DROP INDEX IF EXISTS users_referral_code_idx;
ALTER TABLE users DROP COLUMN IF EXISTS referral_code;
