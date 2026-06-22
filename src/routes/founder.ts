import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { errResponse, AppError, isConnectionError } from "../lib/errors";
import { getFounderStatus, claimFounderBonus } from "../services/founder";

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

// GET /api/founder/status — pure read, no writes
router.get("/status", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const status = await getFounderStatus(req.user!.id);
    res.json(status);
  } catch (err) {
    handleError(err, res);
  }
});

// POST /api/founder/claim — idempotent grant; replay-safe
router.post("/claim", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id: userId, level: userLevel, phone } = req.user!;
    const status = await claimFounderBonus(userId, userLevel, phone);
    res.json(status);
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
