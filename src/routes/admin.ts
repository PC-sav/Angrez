import { Router, Request, Response, NextFunction } from "express";
import { errResponse, AppError, isConnectionError } from "../lib/errors";
import {
  listAllCampaigns,
  createCampaign,
  patchCampaign,
  VALID_CAMPAIGN_TYPES,
} from "../services/campaigns";

const router = Router();

// ── Admin auth middleware ─────────────────────────────────────────────────────
// Reads process.env.ADMIN_API_KEY at request time so tests can inject it via
// process.env without worrying about module-load ordering.

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.ADMIN_API_KEY;
  if (!key || req.headers["x-admin-key"] !== key) {
    res.status(401).json(errResponse("UNAUTHORIZED", "Valid x-admin-key header required."));
    return;
  }
  next();
}

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

// GET /admin/campaigns
router.get("/campaigns", requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const campaigns = await listAllCampaigns();
    res.json(campaigns);
  } catch (err) {
    handleError(err, res);
  }
});

// POST /admin/campaigns
router.post("/campaigns", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const { id, name, type, starts_at, ends_at, quota, award_points,
          price_paise, eligibility_json, daily_quota } = req.body;

  if (!id || !name || !type || !starts_at || !ends_at) {
    res.status(400).json(errResponse("MISSING_FIELDS",
      "id, name, type, starts_at, ends_at are required."));
    return;
  }
  if (!VALID_CAMPAIGN_TYPES.has(type)) {
    res.status(400).json(errResponse("INVALID_TYPE",
      `type must be one of: ${[...VALID_CAMPAIGN_TYPES].join(", ")}.`));
    return;
  }

  try {
    const campaign = await createCampaign({
      id, name, type, starts_at, ends_at, quota, award_points,
      price_paise, eligibility_json, daily_quota,
    });
    res.status(201).json(campaign);
  } catch (err) {
    handleError(err, res);
  }
});

// PATCH /admin/campaigns/:id
router.patch("/campaigns/:id", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const campaignId = req.params.id as string;
  const { id: bodyId, type, ...rest } = req.body;

  if (bodyId !== undefined || type !== undefined) {
    res.status(400).json(errResponse("IMMUTABLE_FIELDS",
      "id and type cannot be changed after creation."));
    return;
  }

  // Only active, quota, ends_at are patchable
  const { active, quota, ends_at } = rest;
  const patch: Record<string, unknown> = {};
  if (active   !== undefined) patch.active   = active;
  if (quota    !== undefined) patch.quota    = quota;
  if (ends_at  !== undefined) patch.ends_at  = ends_at;

  try {
    const campaign = await patchCampaign(campaignId, patch);
    res.json(campaign);
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
