import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { errResponse, AppError, isConnectionError } from "../lib/errors";
import pool from "../lib/db";

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

// GET /api/referral/status — read-only; returns referral counts and points earned.
// A user with no referrals returns { total_referrals: 0, converted: 0, points_earned: 0 }.
router.get("/status", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    // Two separate queries to avoid a cartesian product (referrals × wallet_ledger).
    const [countsRes, pointsRes] = await Promise.all([
      pool.query<{ total_referrals: number; converted: number }>(
        `SELECT
           COUNT(*)::int AS total_referrals,
           COUNT(*) FILTER (WHERE bonus_state = 'converted')::int AS converted
         FROM referrals
         WHERE referrer_id = $1`,
        [userId],
      ),
      pool.query<{ points_earned: number }>(
        `SELECT COALESCE(SUM(delta_points), 0)::int AS points_earned
         FROM wallet_ledger
         WHERE user_id = $1 AND reason = 'referral_credit'`,
        [userId],
      ),
    ]);

    const { total_referrals, converted } = countsRes.rows[0];
    const { points_earned } = pointsRes.rows[0];

    res.json({ total_referrals, converted, points_earned });
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
