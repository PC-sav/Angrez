import pool from "../lib/db";
import { AppError } from "../lib/errors";
import { claimCampaign, type Campaign } from "./campaigns";

export const FOUNDER_BONUS_CAMPAIGN_ID = "founder-bonus";

export interface FounderStatus {
  is_founder: boolean;
  claimed?: boolean;
  founder_bonus_points?: number;
  via?: "first_n" | "waitlist";
}

// Prefer 'first_n' if both clauses match.
async function checkEligibility(
  userId: string,
  phone: string | null,
): Promise<{ is_founder: boolean; via: "first_n" | "waitlist" | null }> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM campaign_grants cg
       JOIN campaigns c ON c.id = cg.campaign_id
       WHERE cg.user_id = $1 AND c.type = 'first_n'
     ) AS exists`,
    [userId],
  );
  if (rows[0]?.exists) return { is_founder: true, via: "first_n" };

  if (phone) {
    const { rows: wl } = await pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM waitlist WHERE phone = $1) AS exists",
      [phone],
    );
    if (wl[0]?.exists) return { is_founder: true, via: "waitlist" };
  }

  return { is_founder: false, via: null };
}

export async function getFounderStatus(userId: string): Promise<FounderStatus> {
  const { rows: uRows } = await pool.query<{ phone: string | null }>(
    "SELECT phone FROM users WHERE id = $1",
    [userId],
  );
  const phone = uRows[0]?.phone ?? null;

  const eligibility = await checkEligibility(userId, phone);
  if (!eligibility.is_founder) return { is_founder: false };

  const { rows: cRows } = await pool.query<{ award_points: number }>(
    "SELECT award_points FROM campaigns WHERE id = $1",
    [FOUNDER_BONUS_CAMPAIGN_ID],
  );
  const founderBonusPoints = cRows[0]?.award_points ?? 0;

  const idemKey = `promo:${FOUNDER_BONUS_CAMPAIGN_ID}:${userId}`;
  const { rows: gRows } = await pool.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM campaign_grants WHERE idempotency_key = $1) AS exists",
    [idemKey],
  );
  const claimed = gRows[0]?.exists ?? false;

  return {
    is_founder: true,
    claimed,
    founder_bonus_points: founderBonusPoints,
    via: eligibility.via!,
  };
}

export async function claimFounderBonus(
  userId: string,
  userLevel: number,
  phone: string | null,
): Promise<FounderStatus> {
  // 1. Eligibility guard — never grant to a non-founder.
  const eligibility = await checkEligibility(userId, phone);
  if (!eligibility.is_founder) {
    throw new AppError("NOT_FOUNDER", "You are not eligible for the founder bonus.", 403);
  }

  // 2. Campaign must exist, be active, and carry points — guard before any write.
  const { rows: cRows } = await pool.query<Campaign>(
    "SELECT * FROM campaigns WHERE id = $1",
    [FOUNDER_BONUS_CAMPAIGN_ID],
  );
  const campaign = cRows[0];
  if (!campaign) {
    throw new AppError(
      "CAMPAIGN_NOT_CONFIGURED",
      "Founder bonus campaign is not configured.",
      503,
    );
  }
  const now = new Date();
  if (!campaign.active || now < campaign.starts_at || now > campaign.ends_at) {
    throw new AppError(
      "CAMPAIGN_UNAVAILABLE",
      "Founder bonus campaign is not currently active.",
      503,
    );
  }
  if (campaign.award_points <= 0) {
    throw new AppError(
      "CAMPAIGN_MISCONFIGURED",
      "Founder bonus campaign has no award points configured.",
      503,
    );
  }

  // 3. Idempotent grant: one wallet_ledger row, key promo:{campaign_id}:{user_id}.
  //    claimCampaign handles quota CAS, ledger write, and ON CONFLICT replay.
  await claimCampaign(FOUNDER_BONUS_CAMPAIGN_ID, userId, userLevel);

  // 4. Denormalised cache — safe to no-op on replay.
  await pool.query(
    "UPDATE users SET is_founder_member = true WHERE id = $1 AND is_founder_member = false",
    [userId],
  );

  // 5. Waitlist: mark claimed (no-op on replay via AND claimed = false guard).
  if (eligibility.via === "waitlist" && phone) {
    await pool.query(
      `UPDATE waitlist
          SET claimed = true, claimed_at = now(), claimed_user_id = $1
        WHERE phone = $2 AND claimed = false`,
      [userId, phone],
    );
  }

  // 6. Return status shape with claimed:true.
  return {
    is_founder: true,
    claimed: true,
    founder_bonus_points: campaign.award_points,
    via: eligibility.via!,
  };
}
