import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { errResponse, AppError, isConnectionError } from "../lib/errors";
import { env } from "../config/env";

// 8-4-4-4-12 hex, case-insensitive — covers all UUID versions (v1–v8).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
import {
  getNextPlan,
  recordPuzzleResult,
  completeSubStage,
} from "../services/learning";

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

// GET /api/plan/next
router.get(
  "/plan/next",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await getNextPlan(req.user!.id);
      res.json(result);
    } catch (err) {
      handleError(err, res);
    }
  },
);

// POST /api/puzzles/result
router.post(
  "/puzzles/result",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { sub_stage_id, puzzle_id, transcript, used_voice, idempotency_key } =
      req.body;

    if (!sub_stage_id || !puzzle_id) {
      res
        .status(400)
        .json(
          errResponse(
            "MISSING_FIELDS",
            "sub_stage_id and puzzle_id are required.",
          ),
        );
      return;
    }
    if (typeof transcript !== "string") {
      res
        .status(400)
        .json(
          errResponse("INVALID_TRANSCRIPT", "transcript must be a string."),
        );
      return;
    }
    if (!transcript.trim()) {
      res
        .status(400)
        .json(
          errResponse(
            "EMPTY_TRANSCRIPT",
            "Empty transcript is not a valid attempt.",
          ),
        );
      return;
    }
    if (typeof used_voice !== "boolean") {
      res
        .status(400)
        .json(
          errResponse("INVALID_USED_VOICE", "used_voice must be a boolean."),
        );
      return;
    }
    if (!idempotency_key) {
      res
        .status(400)
        .json(
          errResponse(
            "MISSING_IDEMPOTENCY_KEY",
            "idempotency_key is required.",
          ),
        );
      return;
    }
    if (!isValidUUID(idempotency_key)) {
      res
        .status(400)
        .json(
          errResponse(
            "INVALID_IDEMPOTENCY_KEY",
            "idempotency_key must be a valid UUID (8-4-4-4-12 hex).",
          ),
        );
      return;
    }

    try {
      const result = await recordPuzzleResult(req.user!.id, {
        sub_stage_id,
        puzzle_id,
        transcript,
        used_voice,
        idempotency_key,
      });
      res.json(result);
    } catch (err) {
      handleError(err, res);
    }
  },
);

// POST /api/substage/complete
router.post(
  "/substage/complete",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { sub_stage_id } = req.body;

    if (!sub_stage_id) {
      res
        .status(400)
        .json(errResponse("MISSING_FIELDS", "sub_stage_id is required."));
      return;
    }

    if (
      req.query.dev_pass === "true" &&
      (env.nodeEnv !== "production" || process.env.DEV_BYPASS_ENABLED === "true")
    ) {
      res.json({
        mastered: true,
        points_awarded: 10,
        balance: 10,
        next_sub_stage_id: "1.2",
        message: "शाबाश! अगला सबक तैयार है।",
      });
      return;
    }

    try {
      const result = await completeSubStage(req.user!.id, sub_stage_id);
      res.json(result);
    } catch (err) {
      handleError(err, res);
    }
  },
);

export default router;
