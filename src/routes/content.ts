import { Router, Request, Response } from "express";
import pool from "../lib/db";
import { requireAuth } from "../middleware/auth";
import { errResponse, isConnectionError } from "../lib/errors";

const router = Router();

function handleError(err: unknown, res: Response): void {
  const pg = err as { code?: string };
  if (pg.code === "22P02") {
    // invalid_text_representation — non-UUID passed where UUID is expected
    res.status(400).json(errResponse("INVALID_ID", "id must be a valid UUID."));
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

/**
 * GET /api/content/packs?language=hi
 *
 * Returns a lightweight list of published content packs for the given language.
 * The full `json` JSONB column is NOT included; callers use the :id route to
 * fetch the full pack before gameplay.
 */
router.get("/packs", requireAuth, async (req: Request, res: Response) => {
  const language = (req.query.language as string | undefined) || "hi";

  try {
    const { rows } = await pool.query(
      `SELECT
         id,
         stage,
         version,
         language,
         json->>'name_en'                       AS name_en,
         json->>'name_l1'                       AS name_l1,
         jsonb_array_length(json->'sub_stages') AS sub_stage_count,
         published_at
       FROM content_packs
       WHERE language = $1
         AND published_at IS NOT NULL
       ORDER BY stage, version`,
      [language],
    );
    res.json({ packs: rows });
  } catch (err) {
    handleError(err, res);
  }
});

/**
 * GET /api/content/packs/:id
 *
 * Returns the full content pack including its json column.
 * Responds with a structured 404 if the pack is not found or not published.
 */
router.get("/packs/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM content_packs
       WHERE id = $1
         AND published_at IS NOT NULL`,
      [req.params.id],
    );

    if (!rows[0]) {
      res.status(404).json(errResponse("NOT_FOUND", "Content pack not found."));
      return;
    }

    res.json({ pack: rows[0] });
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
