import { Router, Request, Response } from "express";
import pool from "../lib/db";
import { requireAuth } from "../middleware/auth";
import { errResponse } from "../lib/errors";

const router = Router();

/**
 * GET /api/content/packs?language=hi
 *
 * Returns a lightweight list of published content packs for the given language.
 * The full `json` JSONB column is NOT included; callers use the :id route to
 * fetch the full pack before gameplay.
 */
router.get("/packs", requireAuth, async (req: Request, res: Response) => {
  const language = (req.query.language as string | undefined) || "hi";

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
});

/**
 * GET /api/content/packs/:id
 *
 * Returns the full content pack including its json column.
 * Responds with a structured 404 if the pack is not found or not published.
 */
router.get("/packs/:id", requireAuth, async (req: Request, res: Response) => {
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
});

export default router;
