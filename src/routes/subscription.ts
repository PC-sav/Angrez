import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { errResponse, isConnectionError } from "../lib/errors";
import pool from "../lib/db";

const router = Router();

// ── GET /api/subscription ─────────────────────────────────────────────────────
// Returns the user's current subscription state.  Server-authoritative — the
// paywall (F7) and any content-gating reads this, never client-held state.

router.get("/", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const { rows } = await pool.query<{
      plan:      string;
      status:    string;
      renews_at: Date | null;
    }>(
      `SELECT plan, status, renews_at
       FROM subscriptions
       WHERE user_id = $1 AND status = 'active'
       ORDER BY started_at DESC
       LIMIT 1`,
      [userId],
    );

    if (!rows[0]) {
      res.json({ plan: "free", status: "none", current_period_end: null });
      return;
    }

    const sub = rows[0];
    const isExpired = sub.renews_at && new Date(sub.renews_at) < new Date();

    res.json({
      plan:               sub.plan,
      status:             isExpired ? "expired" : "active",
      current_period_end: sub.renews_at ? new Date(sub.renews_at).toISOString() : null,
    });
  } catch (err) {
    if (isConnectionError(err)) {
      res
        .set("Retry-After", "5")
        .status(503)
        .json(errResponse("SERVICE_UNAVAILABLE", "Service temporarily unavailable, please retry."));
      return;
    }
    console.error(err);
    res.status(500).json(errResponse("INTERNAL_ERROR", "Internal server error."));
  }
});

export default router;
