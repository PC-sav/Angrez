import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { errResponse, AppError, isConnectionError } from "../lib/errors";
import { getActiveCampaigns, claimCampaign, getActivePricingCampaigns } from "../services/campaigns";
import { getPriceForPlan, type Plan } from "../services/payments";

const router = Router();

function handleError(err: unknown, res: Response): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(errResponse(err.code, err.message));
    return;
  }
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

// GET /api/campaigns/pricing (9C)
// Server-authoritative pricing view for the paywall.  Returns only active
// early_bird_price campaigns whose quota is not yet exhausted (by PAID orders).
// original_amount is the PLAN_CONFIG base price — always the un-discounted value.
router.get("/pricing", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await getActivePricingCampaigns();
    const campaigns = rows.map((c) => ({
      plan:            c.plan,
      campaign_name:   c.name,
      original_amount: getPriceForPlan(c.plan as Plan),
      campaign_price:  c.price_paise / 100,
      currency:        "INR",
      quota_total:     c.quota,
      quota_remaining: c.quota !== null ? c.quota - c.paid_count : null,
      ends_at:         c.ends_at instanceof Date ? c.ends_at.toISOString() : c.ends_at,
    }));
    res.json({ campaigns });
  } catch (err) {
    handleError(err, res);
  }
});

// GET /api/campaigns/active
router.get("/active", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  try {
    const campaigns = await getActiveCampaigns();
    res.json(campaigns);
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/campaigns/:id/claim
router.post("/:id/claim", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const campaignId = req.params.id as string;
  const userId = req.user!.id;
  const userLevel = req.user!.level;

  try {
    const { grant, already_claimed } = await claimCampaign(campaignId, userId, userLevel);
    res.json({
      campaign_id:    grant.campaign_id,
      award_points:   grant.award_points,
      granted_at:     grant.granted_at,
      already_claimed,
    });
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
