import pool from "../lib/db";
import { AppError } from "../lib/errors";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Campaign {
  id: string;
  name: string;
  type: string;
  active: boolean;
  quota: number | null;
  granted_count: number;
  daily_quota: number | null;
  starts_at: Date;
  ends_at: Date;
  award_points: number;
  price_paise: number | null;
  eligibility_json: string | null;
  created_at: Date;
}

export interface CampaignGrant {
  id: number;
  idempotency_key: string;
  campaign_id: string;
  user_id: string;
  granted_at: Date;
  award_points: number;
}

interface EligibilityRule {
  min_stage?: number;
}

export const VALID_CAMPAIGN_TYPES = new Set([
  "bonus_points",
  "streak_freeze",
  "first_n",
  "daily_first_n",
  "early_bird",
]);

// ── 1. Active campaigns ───────────────────────────────────────────────────────

export async function getActiveCampaigns(): Promise<Campaign[]> {
  const { rows } = await pool.query<Campaign>(
    `SELECT id, name, type, award_points, price_paise, quota, granted_count,
            ends_at, active, starts_at, created_at, daily_quota, eligibility_json
     FROM campaigns
     WHERE active = true AND starts_at <= now() AND ends_at >= now()
     ORDER BY created_at DESC`,
  );
  return rows;
}

// ── 2. Claim ──────────────────────────────────────────────────────────────────

export async function claimCampaign(
  campaignId: string,
  userId: string,
  userLevel: number,
): Promise<{ grant: CampaignGrant; already_claimed: boolean }> {
  // Load campaign
  const { rows: camps } = await pool.query<Campaign>(
    "SELECT * FROM campaigns WHERE id = $1",
    [campaignId],
  );
  const campaign = camps[0];
  if (!campaign) {
    throw new AppError("NOT_FOUND", "Campaign not found.", 404);
  }

  // Active + window guard
  const now = new Date();
  if (!campaign.active || now < campaign.starts_at || now > campaign.ends_at) {
    throw new AppError(
      "CAMPAIGN_UNAVAILABLE",
      "This campaign is not currently active.",
      409,
    );
  }

  // Eligibility — min_stage only for now
  if (campaign.eligibility_json) {
    let rule: EligibilityRule = {};
    try {
      rule = JSON.parse(campaign.eligibility_json) as EligibilityRule;
    } catch {
      // malformed eligibility_json — no restriction applied
    }
    if (rule.min_stage !== undefined && userLevel < rule.min_stage) {
      throw new AppError(
        "ELIGIBILITY_NOT_MET",
        `This campaign requires stage ${rule.min_stage} or above.`,
        403,
      );
    }
  }

  const idemKey = `promo:${campaignId}:${userId}`;

  // Fast path: already claimed (avoids opening a transaction on the hot path)
  const { rows: existing } = await pool.query<CampaignGrant>(
    "SELECT * FROM campaign_grants WHERE idempotency_key = $1",
    [idemKey],
  );
  if (existing[0]) {
    return { grant: existing[0], already_claimed: true };
  }

  // Transactional claim
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // CAS increment: zero rows returned means quota is full
    const { rows: cas } = await client.query<{ granted_count: number }>(
      `UPDATE campaigns
       SET granted_count = granted_count + 1
       WHERE id = $1 AND (quota IS NULL OR granted_count < quota)
       RETURNING granted_count`,
      [campaignId],
    );

    if (cas.length === 0) {
      await client.query("ROLLBACK");
      throw new AppError(
        "QUOTA_EXHAUSTED",
        "This campaign has reached its claim limit.",
        409,
      );
    }

    // Insert grant — ON CONFLICT DO NOTHING handles a concurrent duplicate
    const { rows: inserted } = await client.query<CampaignGrant>(
      `INSERT INTO campaign_grants (idempotency_key, campaign_id, user_id, award_points)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [idemKey, campaignId, userId, campaign.award_points],
    );

    if (inserted.length === 0) {
      // Concurrent duplicate won the race — roll back the count increment
      await client.query("ROLLBACK");
      const { rows: orig } = await pool.query<CampaignGrant>(
        "SELECT * FROM campaign_grants WHERE idempotency_key = $1",
        [idemKey],
      );
      return { grant: orig[0], already_claimed: true };
    }

    // Ledger credit in the same transaction
    if (campaign.award_points > 0) {
      await client.query(
        `INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key)
         VALUES ($1, $2, 'promo_grant', $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [userId, campaign.award_points, idemKey],
      );
    }

    await client.query("COMMIT");
    return { grant: inserted[0], already_claimed: false };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // already rolled back — ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

// ── 3. Admin: list all ────────────────────────────────────────────────────────

export async function listAllCampaigns(): Promise<Array<Campaign & { remaining: number | null }>> {
  const { rows } = await pool.query<Campaign & { remaining: number | null }>(
    `SELECT *,
            CASE WHEN quota IS NULL THEN NULL
                 ELSE quota - granted_count
            END AS remaining
     FROM campaigns
     ORDER BY created_at DESC`,
  );
  return rows;
}

// ── 4. Admin: create ──────────────────────────────────────────────────────────

export interface CreateCampaignBody {
  id: string;
  name: string;
  type: string;
  starts_at: string;
  ends_at: string;
  quota?: number | null;
  award_points?: number;
  price_paise?: number | null;
  eligibility_json?: string | null;
  daily_quota?: number | null;
}

export async function createCampaign(body: CreateCampaignBody): Promise<Campaign> {
  const {
    id, name, type, starts_at, ends_at,
    quota = null,
    award_points = 0,
    price_paise = null,
    eligibility_json = null,
    daily_quota = null,
  } = body;

  const { rows } = await pool.query<Campaign>(
    `INSERT INTO campaigns
       (id, name, type, starts_at, ends_at, quota, award_points,
        price_paise, eligibility_json, daily_quota)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [id, name, type, starts_at, ends_at, quota, award_points,
     price_paise, eligibility_json, daily_quota],
  );
  return rows[0];
}

// ── 5. Admin: patch ───────────────────────────────────────────────────────────

export interface PatchCampaignBody {
  active?: boolean;
  quota?: number | null;
  ends_at?: string;
}

export async function patchCampaign(
  campaignId: string,
  body: PatchCampaignBody,
): Promise<Campaign> {
  const { rows: found } = await pool.query<Campaign>(
    "SELECT * FROM campaigns WHERE id = $1",
    [campaignId],
  );
  if (!found[0]) {
    throw new AppError("NOT_FOUND", "Campaign not found.", 404);
  }

  const cur = found[0];
  const active  = body.active   !== undefined ? body.active   : cur.active;
  const quota   = body.quota    !== undefined ? body.quota    : cur.quota;
  const ends_at = body.ends_at  !== undefined ? body.ends_at  : cur.ends_at;

  const { rows } = await pool.query<Campaign>(
    `UPDATE campaigns SET active = $1, quota = $2, ends_at = $3 WHERE id = $4 RETURNING *`,
    [active, quota, ends_at, campaignId],
  );
  return rows[0];
}
