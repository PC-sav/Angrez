import pool from "../lib/db";

// Single config constant — change here to adjust the reward or make it double-sided.
export const REFERRAL_REWARD_POINTS = 100;

/**
 * Resolve a referral code to the referrer's user id.
 * Returns null if the code does not match any user.
 */
export async function resolveReferralCode(code: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE referral_code = $1",
    [code.toUpperCase()],
  );
  return rows[0]?.id ?? null;
}

/**
 * Store a pending referral relationship.
 * Guards enforced here (defence-in-depth; HTTP layer also guards):
 *   - self-referral → silent no-op
 *   - duplicate referee → ON CONFLICT DO NOTHING (one referral per referee, ever)
 */
export async function captureReferral(
  referrerId: string,
  refereeId: string,
  code: string,
): Promise<void> {
  if (referrerId === refereeId) return;
  await pool.query(
    `INSERT INTO referrals (referrer_id, referred_id, code, bonus_state)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (referred_id) DO NOTHING`,
    [referrerId, refereeId, code.toUpperCase()],
  );
}

/**
 * Credit the referrer for a verified referral.
 * Idempotent: two calls with the same (referrerId, refereeId) produce
 * exactly one wallet_ledger row.
 *
 * NOT YET CALLED — this function has no call site until a verified
 * PayU payment event wires it in (later step).
 */
export async function creditReferral(
  referrerId: string,
  refereeId: string,
): Promise<void> {
  if (referrerId === refereeId) return;

  const idemKey = `referral:${referrerId}:${refereeId}`;

  await pool.query(
    `INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key)
     VALUES ($1, $2, 'referral_credit', $3)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [referrerId, REFERRAL_REWARD_POINTS, idemKey],
  );

  await pool.query(
    `UPDATE referrals SET bonus_state = 'converted', conversion_at = now()
     WHERE referrer_id = $1 AND referred_id = $2`,
    [referrerId, refereeId],
  );
}
