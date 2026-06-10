import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { errResponse, isConnectionError } from "../lib/errors";
import pool from "../lib/db";

const router = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function handleError(err: unknown, res: Response): void {
  if (isConnectionError(err)) {
    res
      .set("Retry-After", "5")
      .status(503)
      .json(
        errResponse("SERVICE_UNAVAILABLE", "Service temporarily unavailable, please retry."),
      );
    return;
  }
  console.error(err);
  res.status(500).json(errResponse("INTERNAL", "Internal server error."));
}

// ── GET /wallet ───────────────────────────────────────────────────────────────
// Balance from the wallet_balances VIEW (MP-10 invariant: never recompute
// inline) + newest-first paginated ledger entries.  Read-only — no writes.

router.get("/", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const rawLimit = parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);
    const limit = Math.min(
      isNaN(rawLimit) || rawLimit < 1 ? DEFAULT_LIMIT : rawLimit,
      MAX_LIMIT,
    );
    const rawOffset = parseInt(String(req.query.offset ?? "0"), 10);
    const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

    const [balRes, txRes] = await Promise.all([
      pool.query<{ balance: number }>(
        "SELECT balance FROM wallet_balances WHERE user_id = $1",
        [userId],
      ),
      pool.query<{ id: string; delta_points: number; reason: string; created_at: string }>(
        `SELECT id, delta_points, reason, created_at
         FROM wallet_ledger
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      ),
    ]);

    res.json({
      balance: balRes.rows[0]?.balance ?? 0,
      transactions: txRes.rows,
      limit,
      offset,
    });
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
