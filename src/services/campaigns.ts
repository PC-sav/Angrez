import type { PoolClient } from "pg";
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
  plan: string | null;
  created_at: Date;
}

export interface PricingCampaignRow {
  id: string;
  name: string;
  plan: string;
  price_paise: number;
  quota: number | null;
  ends_at: Date;
  paid_count: number;
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
  "early_bird_price",  // 9C: price-override campaigns
]);

// ── 1. Active campaigns ───────────────────────────────────────────────────────

export async function getActiveCampaigns(): Promise<Campaign[]> {
  const { rows } = await pool.query<Campaign>(
    `SELECT id, name, type, award_points, price_paise, quota, granted_count,
            ends_at, active, starts_at, created_at, daily_quota, eligibility_json, plan
     FROM campaigns
     WHERE active = true AND starts_at <= now() AND ends_at >= now()
     ORDER BY created_at DESC`,
  );
  return rows;
}

// ── 1b. Active pricing campaigns (9C) ────────────────────────────────────────
// Returns early_bird_price campaigns that are in-window and have quota remaining.
// quota_remaining is computed from PAID orders only (CREATED orders never consume quota).

export async function getActivePricingCampaigns(): Promise<PricingCampaignRow[]> {
  const { rows } = await pool.query<PricingCampaignRow>(
    `SELECT
       c.id, c.name, c.plan, c.price_paise, c.quota, c.ends_at,
       (SELECT COUNT(*)::INT FROM orders o
        WHERE o.campaign_id = c.id AND o.status = 'PAID') AS paid_count
     FROM campaigns c
     WHERE c.type = 'early_bird_price'
       AND c.active = true
       AND c.plan IS NOT NULL
       AND now() BETWEEN c.starts_at AND c.ends_at
       AND (c.quota IS NULL OR
            (SELECT COUNT(*) FROM orders o
             WHERE o.campaign_id = c.id AND o.status = 'PAID') < c.quota)
     ORDER BY c.price_paise ASC`,
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
  plan?: string | null;
}

export async function createCampaign(body: CreateCampaignBody): Promise<Campaign> {
  const {
    id, name, type, starts_at, ends_at,
    quota = null,
    award_points = 0,
    price_paise = null,
    eligibility_json = null,
    daily_quota = null,
    plan = null,
  } = body;

  const { rows } = await pool.query<Campaign>(
    `INSERT INTO campaigns
       (id, name, type, starts_at, ends_at, quota, award_points,
        price_paise, eligibility_json, daily_quota, plan)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [id, name, type, starts_at, ends_at, quota, award_points,
     price_paise, eligibility_json, daily_quota, plan],
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

  // Toggle: activating an early_bird_price campaign deactivates all other
  // early_bird_price campaigns for the same plan.  Safety net (spec §9C.3):
  // if two somehow remain active, resolvePrice picks the lowest price.
  if (active === true && cur.type === "early_bird_price" && cur.plan) {
    await pool.query(
      `UPDATE campaigns SET active = false
       WHERE type = 'early_bird_price' AND plan = $1 AND id != $2`,
      [cur.plan, campaignId],
    );
  }

  const { rows } = await pool.query<Campaign>(
    `UPDATE campaigns SET active = $1, quota = $2, ends_at = $3 WHERE id = $4 RETURNING *`,
    [active, quota, ends_at, campaignId],
  );
  return rows[0];
}

// ── 6. Hook: First-N signup ───────────────────────────────────────────────────

// Advisory lock key for signup_rank serialisation.
// pg_advisory_xact_lock(key) is an application-level mutex released at COMMIT/
// ROLLBACK. Unlike LOCK TABLE it does not touch the table's metadata lock, so
// VACUUM, ANALYZE, concurrent index builds and schema inspection are unaffected.
const FIRST_N_RANK_LOCK = 71697273746e0; // "firstn" mnemonic, fits in float64

/**
 * Assigns a sequential signup_rank to userId, then claims any active first_n
 * campaigns for which signupRank <= quota.
 *
 * FOR UPDATE cannot serialise here: MAX() on an empty/partially-filled table
 * returns no lockable rows, so two concurrent transactions both compute rank=1
 * and both INSERT without conflict (no UNIQUE on signup_rank).
 * ON CONFLICT retry also requires a UNIQUE(signup_rank) constraint that the
 * current schema does not have.
 * An advisory lock serialises all callers of this hook without those constraints.
 * Callers must wrap in try/catch — errors here must never fail user signup.
 */
export async function runFirstNSignupHook(userId: string): Promise<void> {
  // Only proceed if at least one first_n campaign is currently active.
  // This prevents first_n_signups from accumulating rows for users who signed
  // up when no campaign was running.
  const campaigns = await getActiveCampaigns();
  const firstNCampaigns = campaigns.filter((c) => c.type === "first_n");
  if (firstNCampaigns.length === 0) return;

  // Atomically assign signup_rank via advisory lock.
  const client = await pool.connect();
  let signupRank: number;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [FIRST_N_RANK_LOCK]);
    const { rows } = await client.query<{ signup_rank: string }>(
      `INSERT INTO first_n_signups (user_id, signup_rank)
       SELECT $1, COALESCE(MAX(signup_rank), 0) + 1 FROM first_n_signups
       RETURNING signup_rank`,
      [userId],
    );
    await client.query("COMMIT");
    signupRank = Number(rows[0].signup_rank); // BIGINT → string in pg driver
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const campaign of firstNCampaigns) {
    if (campaign.quota !== null && signupRank > campaign.quota) continue;
    try {
      await claimCampaign(campaign.id, userId, 1); // new users are always level 1
    } catch {
      // quota filled between rank assignment and claim — acceptable
    }
  }
}

// ── 7. Hook: Daily-First-N substage completion ────────────────────────────────

/**
 * Assigns a daily rank per active daily_first_n campaign, then claims if
 * rank <= daily_quota. Uses the UNIQUE(campaign_id, day, rank) constraint
 * for race safety via retry-on-conflict rather than a table lock.
 * Callers must wrap in try/catch — errors here must never fail substage completion.
 */
export async function runDailyFirstNHook(userId: string): Promise<void> {
  const { rows: userRows } = await pool.query<{ level: number }>(
    "SELECT level FROM users WHERE id = $1",
    [userId],
  );
  const userLevel = userRows[0]?.level ?? 1;

  const campaigns = await getActiveCampaigns();
  for (const campaign of campaigns) {
    if (campaign.type !== "daily_first_n" || campaign.daily_quota === null) continue;

    // Idempotency: skip if this user already has a rank today
    const { rows: existing } = await pool.query<{ rank: number }>(
      `SELECT rank FROM daily_first_n
       WHERE user_id = $1 AND campaign_id = $2 AND day = CURRENT_DATE`,
      [userId, campaign.id],
    );
    if (existing[0]) {
      if (existing[0].rank <= campaign.daily_quota) {
        try { await claimCampaign(campaign.id, userId, userLevel); } catch {}
      }
      continue;
    }

    // Assign rank; retry up to 5 times on UNIQUE(campaign_id, day, rank) conflict
    let rank: number | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { rows } = await pool.query<{ rank: number }>(
        `INSERT INTO daily_first_n (user_id, campaign_id, day, rank)
         SELECT $1, $2, CURRENT_DATE, COALESCE(MAX(rank), 0) + 1
         FROM daily_first_n WHERE campaign_id = $2 AND day = CURRENT_DATE
         ON CONFLICT (campaign_id, day, rank) DO NOTHING
         RETURNING rank`,
        [userId, campaign.id],
      );
      if (rows[0]) { rank = rows[0].rank; break; }
    }

    if (rank !== null && rank <= campaign.daily_quota) {
      try { await claimCampaign(campaign.id, userId, userLevel); } catch {}
    }
  }
}

// ── 8. Pricing-quota consumption (9C webhook) ─────────────────────────────────
// Called from the webhook's CREATED→PAID transition, inside the SAME transaction
// that flips the order to PAID, so the count only moves when a payment actually
// lands and is never double-counted on replay.
//
// Zero rows updated = quota already full or campaign not found.  That is NOT an
// error: the customer's price was frozen at order-create time, so the payment
// must succeed regardless.  We simply don't bump the counter.
export async function consumePricingQuota(
  campaignId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE campaigns
        SET granted_count = granted_count + 1
      WHERE id = $1
        AND type = 'early_bird_price'
        AND (quota IS NULL OR granted_count < quota)`,
    [campaignId],
  );
}
