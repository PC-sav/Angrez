import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { errResponse, isConnectionError } from "../lib/errors";
import { getActivePricingCampaigns } from "../services/campaigns";
import { getPriceForPlan, type Plan } from "../services/payments";

const router = Router();

// Display order: featured plan first.
const PLAN_ORDER: Plan[] = ["year", "month", "trial"];

// GET /api/plans
// Returns base price + active campaign overlay for every tier in one call.
// base_amount always comes from getPriceForPlan (single price source — no literals).
// campaign_* fields are null when no active early_bird_price campaign exists for that tier.
router.get("/", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await getActivePricingCampaigns();

    // Build plan → lowest-price campaign map. Query returns rows ORDER BY price_paise ASC,
    // so the first occurrence per plan is cheapest — only set if the plan key is absent.
    const campaignByPlan = new Map<string, typeof rows[0]>();
    for (const r of rows) {
      if (!campaignByPlan.has(r.plan)) campaignByPlan.set(r.plan, r);
    }

    const plans = PLAN_ORDER.map((plan) => {
      const c = campaignByPlan.get(plan) ?? null;
      return {
        plan,
        base_amount:     getPriceForPlan(plan),
        campaign_price:  c ? c.price_paise / 100 : null,
        currency:        "INR",
        campaign_name:   c ? c.name : null,
        quota_remaining: c ? (c.quota !== null ? c.quota - c.paid_count : null) : null,
        ends_at:         c ? (c.ends_at instanceof Date ? c.ends_at.toISOString() : c.ends_at) : null,
      };
    });

    res.json({ plans });
  } catch (err) {
    if (isConnectionError(err)) {
      res
        .set("Retry-After", "5")
        .status(503)
        .json(errResponse("SERVICE_UNAVAILABLE", "Service temporarily unavailable, please retry."));
      return;
    }
    console.error(err);
    res.status(500).json(errResponse("INTERNAL", "Internal server error."));
  }
});

export default router;
