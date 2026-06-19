import pool from "../lib/db";
import { matchAnswer } from "./matcher";
import { AppError } from "../lib/errors";
import { runDailyFirstNHook } from "./campaigns";

// ── Pack JSON types ────────────────────────────────────────────────────────────

interface PackPoints {
  puzzle_base: number;
  voice_bonus: number;
  sub_stage_complete: number;
  sub_stage_perfect_bonus: number;
  [key: string]: number;
}

interface PackFeedback {
  celebrate_l1: string[];
  good_effort_l1: string;
  almost_l1: string;
  [key: string]: unknown;
}

interface PuzzleJson {
  id: string;
  accept?: string[];
  accept_frames?: string[];
  open_ended?: boolean;
  [key: string]: unknown;
}

interface SubStageJson {
  id: string;
  title_en?: string;
  title_l1?: string;
  micro_skill_l1?: string;
  warmup?: { audio?: string; [key: string]: unknown };
  teach?: unknown[];
  practice?: PuzzleJson[];
  mastery_check?: PuzzleJson[];
  [key: string]: unknown;
}

interface PackJson {
  stage: number;
  version: number;
  language: string;
  mastery_threshold: number;
  points: PackPoints;
  feedback: PackFeedback;
  sub_stages: SubStageJson[];
  [key: string]: unknown;
}

// ── Content helpers ────────────────────────────────────────────────────────────

async function loadPacksForLanguage(
  language: string,
): Promise<Array<{ dbId: string; pack: PackJson }>> {
  const { rows } = await pool.query<{ id: string; json: PackJson }>(
    `SELECT DISTINCT ON ((json->>'stage')::int) id, json
     FROM content_packs
     WHERE language = $1 AND published_at IS NOT NULL
     ORDER BY (json->>'stage')::int, (json->>'version')::int DESC`,
    [language],
  );
  return rows.map((r) => ({ dbId: r.id, pack: r.json }));
}

async function loadPackForSubStage(
  subStageId: string,
  language: string,
): Promise<{ dbId: string; pack: PackJson }> {
  const stage = parseInt(subStageId.split(".")[0], 10);
  if (isNaN(stage)) {
    throw new AppError("NOT_FOUND", "Invalid sub_stage_id format.", 404);
  }
  const { rows } = await pool.query<{ id: string; json: PackJson }>(
    `SELECT id, json FROM content_packs
     WHERE stage = $1 AND language = $2 AND published_at IS NOT NULL
     ORDER BY version DESC LIMIT 1`,
    [stage, language],
  );
  if (!rows[0]) {
    throw new AppError(
      "NOT_FOUND",
      "Content pack not found for this stage.",
      404,
    );
  }
  return { dbId: rows[0].id, pack: rows[0].json };
}

function findPuzzle(
  pack: PackJson,
  subStageId: string,
  puzzleId: string,
): PuzzleJson {
  const ss = pack.sub_stages.find((s) => s.id === subStageId);
  if (!ss) {
    throw new AppError("NOT_FOUND", `Sub-stage ${subStageId} not found.`, 404);
  }
  for (const arr of [ss.practice ?? [], ss.mastery_check ?? []]) {
    const found = arr.find((p) => p.id === puzzleId);
    if (found) return found;
  }
  throw new AppError(
    "NOT_FOUND",
    `Puzzle ${puzzleId} not found in sub-stage ${subStageId}.`,
    404,
  );
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function getBalance(userId: string): Promise<number> {
  const { rows } = await pool.query<{ balance: number }>(
    `SELECT COALESCE(SUM(delta_points), 0)::INT AS balance
     FROM wallet_ledger WHERE user_id = $1`,
    [userId],
  );
  return rows[0].balance;
}

async function getUserLanguage(userId: string): Promise<string> {
  const { rows } = await pool.query<{ language: string }>(
    "SELECT language FROM users WHERE id = $1",
    [userId],
  );
  if (!rows[0]) throw new AppError("NOT_FOUND", "User not found.", 404);
  return rows[0].language || "hi";
}

// ── 1. GET /plan/next ──────────────────────────────────────────────────────────

export async function getNextPlan(userId: string) {
  const language = await getUserLanguage(userId);
  const packs = await loadPacksForLanguage(language);

  if (packs.length === 0) {
    throw new AppError(
      "NO_CONTENT",
      "No content available for your language.",
      404,
    );
  }

  const { rows: progressRows } = await pool.query<{
    sub_stage_id: string;
    status: string;
    mastery_score: string;
  }>(
    `SELECT sub_stage_id, status, mastery_score FROM progress WHERE user_id = $1`,
    [userId],
  );
  const progressMap = new Map(
    progressRows.map((r) => [
      r.sub_stage_id,
      { status: r.status, mastery_score: Number(r.mastery_score) },
    ]),
  );

  let currentPack: PackJson | null = null;
  let currentPackDbId: string | null = null;
  let currentSS: SubStageJson | null = null;

  for (const { dbId, pack } of packs) {
    for (const ss of pack.sub_stages) {
      const prog = progressMap.get(ss.id);
      if (!prog || prog.status !== "complete") {
        currentPack = pack;
        currentPackDbId = dbId;
        currentSS = ss;
        break;
      }
    }
    if (currentSS) break;
  }

  // All sub-stages complete → return last one
  if (!currentSS) {
    const last = packs[packs.length - 1];
    currentPack = last.pack;
    currentPackDbId = last.dbId;
    currentSS = last.pack.sub_stages[last.pack.sub_stages.length - 1];
  }

  const prog = progressMap.get(currentSS!.id);
  const threshold = (currentPack!.mastery_threshold ?? 0.7) * 100;

  const review: Array<{ sub_stage_id: string; mastery_score: number }> = [];
  for (const { pack } of packs) {
    for (const ss of pack.sub_stages) {
      if (ss.id === currentSS!.id) continue;
      const p = progressMap.get(ss.id);
      if (p?.status === "complete" && p.mastery_score < threshold) {
        review.push({ sub_stage_id: ss.id, mastery_score: p.mastery_score });
      }
    }
  }

  return {
    pack_id: currentPackDbId,
    sub_stage_id: currentSS!.id,
    title_en: currentSS!.title_en,
    title_l1: currentSS!.title_l1,
    micro_skill_l1: currentSS!.micro_skill_l1,
    warmup: currentSS!.warmup ?? null,
    teach: currentSS!.teach ?? [],
    practice: currentSS!.practice ?? [],
    status: prog?.status ?? "not_started",
    mastery_score: prog?.mastery_score ?? 0,
    review,
  };
}

// ── 2. POST /puzzles/result ───────────────────────────────────────────────────

export interface PuzzleResultBody {
  sub_stage_id: string;
  puzzle_id: string;
  transcript: string;
  used_voice: boolean;
  idempotency_key: string;
}

export async function recordPuzzleResult(
  userId: string,
  body: PuzzleResultBody,
) {
  const { sub_stage_id, puzzle_id, transcript, used_voice, idempotency_key } =
    body;

  const language = await getUserLanguage(userId);
  const { pack } = await loadPackForSubStage(sub_stage_id, language);
  const puzzle = findPuzzle(pack, sub_stage_id, puzzle_id);

  const { pass, matched, mode } = matchAnswer(puzzle, transcript);
  // Clamp to zero: pack authors should never produce negative values, but if
  // degenerate point data reaches the API it must never create a negative delta.
  const pointsAwarded = Math.max(
    0,
    pack.points.puzzle_base + (used_voice ? pack.points.voice_bonus : 0),
  );

  let isRetry = false;
  let finalPoints = pointsAwarded;
  let finalMatched = matched;
  let finalPass = pass;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: existing } = await client.query<{
      correct: boolean;
      points_awarded: number;
    }>(
      `SELECT pr.correct, pr.points_awarded
       FROM wallet_ledger wl
       JOIN puzzle_results pr ON pr.id::text = wl.ref_id
       WHERE wl.idempotency_key = $1 AND wl.user_id = $2`,
      [idempotency_key, userId],
    );

    if (existing[0]) {
      isRetry = true;
      finalPoints = existing[0].points_awarded;
      finalMatched = existing[0].correct;
      finalPass = existing[0].correct;
      await client.query("COMMIT");
    } else {
      const {
        rows: [pr],
      } = await client.query<{ id: string }>(
        `INSERT INTO puzzle_results
           (user_id, sub_stage_id, puzzle_id, used_voice, correct, transcript, points_awarded)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          userId,
          sub_stage_id,
          puzzle_id,
          used_voice,
          matched,
          transcript,
          pointsAwarded,
        ],
      );

      await client.query(
        `INSERT INTO wallet_ledger
           (user_id, delta_points, reason, idempotency_key, ref_id)
         VALUES ($1, $2, 'puzzle_result', $3, $4)`,
        [userId, pointsAwarded, idempotency_key, pr.id],
      );

      await client.query("COMMIT");
    }
  } catch (err: unknown) {
    await client.query("ROLLBACK");
    // Concurrent retry hit the unique constraint before our idempotency SELECT
    if ((err as { code?: string }).code === "23505") {
      isRetry = true;
      const { rows: orig } = await pool.query<{
        correct: boolean;
        points_awarded: number;
      }>(
        `SELECT pr.correct, pr.points_awarded
         FROM wallet_ledger wl
         JOIN puzzle_results pr ON pr.id::text = wl.ref_id
         WHERE wl.idempotency_key = $1 AND wl.user_id = $2`,
        [idempotency_key, userId],
      );
      if (orig[0]) {
        finalPoints = orig[0].points_awarded;
        finalMatched = orig[0].correct;
        finalPass = orig[0].correct;
      }
    } else {
      throw err;
    }
  } finally {
    client.release();
  }

  // Update progress (outside transaction; mastery is recomputed from all results)
  if (!isRetry) {
    const {
      rows: [stats],
    } = await pool.query<{ total: number; correct_count: number }>(
      `SELECT COUNT(*)::int          AS total,
              COUNT(*) FILTER (WHERE correct = true)::int AS correct_count
       FROM puzzle_results
       WHERE user_id = $1 AND sub_stage_id = $2`,
      [userId, sub_stage_id],
    );

    const mastery =
      stats.total > 0 ? (stats.correct_count / stats.total) * 100 : 0;
    const wordsSpokenDelta = used_voice ? 1 : 0;

    await pool.query(
      `INSERT INTO progress (user_id, sub_stage_id, status, mastery_score, words_spoken)
       VALUES ($1, $2, 'in_progress', $3, $4)
       ON CONFLICT (user_id, sub_stage_id) DO UPDATE SET
         status        = CASE WHEN progress.status = 'complete' THEN 'complete' ELSE 'in_progress' END,
         mastery_score = EXCLUDED.mastery_score,
         words_spoken  = progress.words_spoken + $4,
         updated_at    = now()`,
      [userId, sub_stage_id, mastery, wordsSpokenDelta],
    );
  }

  const balance = await getBalance(userId);

  const celebrate = finalMatched
    ? pickRandom(pack.feedback.celebrate_l1)
    : finalPass
      ? pack.feedback.good_effort_l1
      : pack.feedback.almost_l1;

  return {
    pass: finalPass,
    matched: finalMatched,
    mode,
    points_awarded: finalPoints,
    balance,
    celebrate,
    is_retry: isRetry,
  };
}

// ── 3. POST /substage/complete ────────────────────────────────────────────────

export async function completeSubStage(userId: string, subStageId: string) {
  const language = await getUserLanguage(userId);
  const { pack } = await loadPackForSubStage(subStageId, language);

  const ssIndex = pack.sub_stages.findIndex((s) => s.id === subStageId);
  if (ssIndex === -1) {
    throw new AppError("NOT_FOUND", `Sub-stage ${subStageId} not found.`, 404);
  }

  const {
    rows: [stats],
  } = await pool.query<{ total: number; correct_count: number }>(
    `SELECT COUNT(*)::int          AS total,
            COUNT(*) FILTER (WHERE correct = true)::int AS correct_count
     FROM puzzle_results
     WHERE user_id = $1 AND sub_stage_id = $2`,
    [userId, subStageId],
  );

  const total = stats.total;
  const correctCount = stats.correct_count;
  const mastery = total > 0 ? correctCount / total : 0;
  const threshold = pack.mastery_threshold ?? 0.7;

  if (mastery < threshold) {
    return {
      mastered: false,
      points_awarded: 0,
      balance: await getBalance(userId),
      next_sub_stage_id: null,
      message: pack.feedback.almost_l1,
    };
  }

  const idemKeyComplete = `substage:${userId}:${subStageId}`;
  const idemKeyPerfect = `substage_perfect:${userId}:${subStageId}`;
  const isPerfect = total > 0 && correctCount === total;
  const nextSS = pack.sub_stages[ssIndex + 1] ?? null;

  const { rows: existingAwards } = await pool.query<{ idempotency_key: string }>(
    `SELECT idempotency_key FROM wallet_ledger
     WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idemKeyComplete],
  );
  const alreadyAwarded = existingAwards.length > 0;

  let pointsAwarded = 0;

  // Progress writes run on EVERY mastered completion (idempotent).
  const progressClient = await pool.connect();
  try {
    await progressClient.query("BEGIN");

    await progressClient.query(
      `INSERT INTO progress (user_id, sub_stage_id, status, mastery_score)
       VALUES ($1, $2, 'complete', $3)
       ON CONFLICT (user_id, sub_stage_id) DO UPDATE SET
         status        = 'complete',
         mastery_score = EXCLUDED.mastery_score,
         updated_at    = now()`,
      [userId, subStageId, mastery * 100],
    );

    if (nextSS) {
      await progressClient.query(
        `INSERT INTO progress (user_id, sub_stage_id, status)
         VALUES ($1, $2, 'not_started')
         ON CONFLICT (user_id, sub_stage_id) DO NOTHING`,
        [userId, nextSS.id],
      );
    }

    await progressClient.query("COMMIT");
  } catch (err) {
    await progressClient.query("ROLLBACK");
    throw err;
  } finally {
    progressClient.release();
  }

  // Wallet writes run only on first completion (points must never be awarded twice).
  if (!alreadyAwarded) {
    const walletClient = await pool.connect();
    try {
      await walletClient.query("BEGIN");

      await walletClient.query(
        `INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key)
         VALUES ($1, $2, 'sub_stage_complete', $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [userId, pack.points.sub_stage_complete, idemKeyComplete],
      );
      pointsAwarded += pack.points.sub_stage_complete;

      if (isPerfect) {
        await walletClient.query(
          `INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key)
           VALUES ($1, $2, 'sub_stage_perfect_bonus', $3)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [userId, pack.points.sub_stage_perfect_bonus, idemKeyPerfect],
        );
        pointsAwarded += pack.points.sub_stage_perfect_bonus;
      }

      await walletClient.query("COMMIT");
    } catch (err) {
      await walletClient.query("ROLLBACK");
      throw err;
    } finally {
      walletClient.release();
    }
  }

  const result = {
    mastered: true,
    points_awarded: pointsAwarded,
    balance: await getBalance(userId),
    next_sub_stage_id: nextSS?.id ?? null,
    message: pickRandom(pack.feedback.celebrate_l1),
  };

  try {
    await runDailyFirstNHook(userId);
  } catch (hookErr) {
    console.error("[completeSubStage] daily-first-N hook:", hookErr);
  }

  return result;
}
