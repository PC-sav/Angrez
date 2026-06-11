/**
 * tests/learning.test.ts
 *
 * Integration tests for the learning loop (Step 5).
 * Runs against a real Supabase database — DATABASE_URL must be set.
 *
 * Tests use a fixed test user and a self-contained content pack (stage 99)
 * so they never depend on production-seeded data. All test data is cleaned
 * up in afterAll.
 */

import "dotenv/config";
import { randomUUID, randomInt } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pool from "../src/lib/db";
import app from "../src/app";
import { signJwt } from "../src/services/jwt";

// ── Test fixtures ─────────────────────────────────────────────────────────────

// Fresh UUID per run so wallet_ledger rows from prior runs never interfere.
const TEST_USER_ID = randomUUID();
const TEST_PHONE = `+91${randomInt(6_000_000_000, 9_999_999_999)}`;

// Stage 9901 is reserved for learning tests only (content.test.ts uses stage 99).
const TEST_STAGE = 9901;
const SS1 = "9901.1"; // for puzzle tests
const SS2 = "9901.2"; // below-threshold complete test (no puzzle_results inserted)
const SS3 = "9901.3"; // above-threshold complete test (puzzle_results inserted in test)
const SS4 = "9901.4"; // next sub-stage — should be unlocked when SS3 completes

const PUZZLE_BASE = 5;
const VOICE_BONUS = 3;

const TEST_PACK = {
  stage: TEST_STAGE,
  version: 1,
  language: "hi",
  name_en: "Test Pack",
  mastery_threshold: 0.7,
  points: {
    puzzle_base: PUZZLE_BASE,
    voice_bonus: VOICE_BONUS,
    sub_stage_complete: 20,
    sub_stage_perfect_bonus: 10,
    bravery_bonus: 0,
    daily_open: 0,
  },
  feedback: {
    celebrate_l1: ["बढ़िया!", "शाबाश!"],
    good_effort_l1: "अच्छी कोशिश!",
    almost_l1: "लगभग! एक बार और?",
    heard_prefix_l1: "सुना",
    mic_broken_l1: "",
    noise_high_l1: "",
    silence_l1: "",
    ready_to_listen_l1: "",
  },
  sub_stages: [
    {
      id: SS1,
      title_en: "Test Sub-Stage 1",
      teach: [],
      practice: [
        // open_ended, no hints → pass=true & matched=true for any non-empty
        { id: "9901.1.p1", type: "test", open_ended: true },
        // accept only → pass=matched=true only for "hello"
        { id: "9901.1.p2", type: "test", accept: ["hello"] },
        // open_ended_with_hints → pass=true always, matched=true only if transcript matches
        {
          id: "9901.1.p3",
          type: "test",
          open_ended: true,
          accept: ["specific phrase"],
        },
      ],
    },
    {
      id: SS2,
      title_en: "Test Sub-Stage 2",
      teach: [],
      practice: [{ id: "9901.2.p1", type: "test", open_ended: true }],
    },
    {
      id: SS3,
      title_en: "Test Sub-Stage 3",
      teach: [],
      practice: [{ id: "9901.3.p1", type: "test", open_ended: true }],
    },
    {
      id: SS4,
      title_en: "Test Sub-Stage 4",
      teach: [],
      practice: [{ id: "9901.4.p1", type: "test", open_ended: true }],
    },
  ],
};

// ── Setup / teardown ──────────────────────────────────────────────────────────

let token: string;

beforeAll(async () => {
  await pool.query(
    `INSERT INTO users (id, phone, language, level)
     VALUES ($1, $2, 'hi', 1)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, TEST_PHONE],
  );

  await pool.query(
    `INSERT INTO content_packs (stage, version, language, json, published_at)
     VALUES ($1, 1, 'hi', $2::jsonb, now())
     ON CONFLICT (stage, version, language)
     DO UPDATE SET json = EXCLUDED.json, published_at = EXCLUDED.published_at`,
    [TEST_STAGE, JSON.stringify(TEST_PACK)],
  );

  token = signJwt({ sub: TEST_USER_ID, phone: TEST_PHONE });
});

afterAll(async () => {
  // wallet_ledger is append-only (trigger blocks DELETE) and has ON DELETE RESTRICT,
  // so we cannot delete wallet_ledger rows or the user. Clean up what we can.
  await pool.query("DELETE FROM puzzle_results WHERE user_id = $1", [TEST_USER_ID]);
  await pool.query("DELETE FROM progress WHERE user_id = $1", [TEST_USER_ID]);
  await pool.query(
    "DELETE FROM content_packs WHERE stage = $1 AND language = 'hi'",
    [TEST_STAGE],
  );
  // wallet_ledger rows and the test user row remain in DB (acceptable for test env).
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/plan/next
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/plan/next", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/plan/next");
    expect(res.status).toBe(401);
  });

  it("returns 200 with the expected shape", async () => {
    const res = await request(app)
      .get("/api/plan/next")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.sub_stage_id).toBe("string");
    expect(typeof res.body.pack_id).toBe("string");
    expect(Array.isArray(res.body.teach)).toBe(true);
    expect(Array.isArray(res.body.practice)).toBe(true);
    expect(Array.isArray(res.body.review)).toBe(true);
    expect(typeof res.body.mastery_score).toBe("number");
    expect(typeof res.body.status).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/puzzles/result
// ─────────────────────────────────────────────────────────────────────────────

function puzzleBody(overrides: Record<string, unknown> = {}) {
  return {
    sub_stage_id: SS1,
    puzzle_id: "9901.1.p1",
    transcript: "anything",
    used_voice: false,
    idempotency_key: randomUUID(),
    ...overrides,
  };
}

describe("POST /api/puzzles/result — validation", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).post("/api/puzzles/result").send(puzzleBody());
    expect(res.status).toBe(401);
  });

  it("returns 400 EMPTY_TRANSCRIPT for whitespace-only transcript", async () => {
    const res = await request(app)
      .post("/api/puzzles/result")
      .set("Authorization", `Bearer ${token}`)
      .send(puzzleBody({ transcript: "   " }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("EMPTY_TRANSCRIPT");
  });

  it("returns 400 MISSING_IDEMPOTENCY_KEY when key is absent", async () => {
    const { idempotency_key: _drop, ...body } = puzzleBody() as {
      idempotency_key: string;
      [k: string]: unknown;
    };
    const res = await request(app)
      .post("/api/puzzles/result")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("returns 404 for unknown puzzle_id", async () => {
    const res = await request(app)
      .post("/api/puzzles/result")
      .set("Authorization", `Bearer ${token}`)
      .send(puzzleBody({ puzzle_id: "does-not-exist" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/puzzles/result — scoring", () => {
  it("awards puzzle_base when used_voice=false", async () => {
    const res = await request(app)
      .post("/api/puzzles/result")
      .set("Authorization", `Bearer ${token}`)
      .send(puzzleBody({ used_voice: false }));
    expect(res.status).toBe(200);
    expect(res.body.points_awarded).toBe(PUZZLE_BASE);
    expect(res.body.is_retry).toBe(false);
  });

  it("awards puzzle_base + voice_bonus when used_voice=true", async () => {
    const res = await request(app)
      .post("/api/puzzles/result")
      .set("Authorization", `Bearer ${token}`)
      .send(puzzleBody({ used_voice: true }));
    expect(res.status).toBe(200);
    expect(res.body.points_awarded).toBe(PUZZLE_BASE + VOICE_BONUS);
  });

  it("open_ended pass with no accept-match still earns points (mode=open_ended_with_hints)", async () => {
    // 9901.1.p3 is open_ended=true + accept=['specific phrase']
    // Sending a non-matching transcript → pass=true, matched=false, but points awarded
    const res = await request(app)
      .post("/api/puzzles/result")
      .set("Authorization", `Bearer ${token}`)
      .send(
        puzzleBody({
          puzzle_id: "9901.1.p3",
          transcript: "random words that do not match",
          used_voice: true,
        }),
      );
    expect(res.status).toBe(200);
    expect(res.body.pass).toBe(true); // open_ended → pass=true for non-empty
    expect(res.body.matched).toBe(false); // did not match the accept list
    expect(res.body.points_awarded).toBe(PUZZLE_BASE + VOICE_BONUS); // still earns!
    expect(res.body.mode).toBe("open_ended_with_hints");
  });

  it("balance field is a number and reflects ledger total", async () => {
    const res = await request(app)
      .post("/api/puzzles/result")
      .set("Authorization", `Bearer ${token}`)
      .send(puzzleBody());
    expect(res.status).toBe(200);
    expect(typeof res.body.balance).toBe("number");
    expect(res.body.balance).toBeGreaterThan(0);
  });

  it("celebrate string comes from pack.feedback (not hardcoded)", async () => {
    const res = await request(app)
      .post("/api/puzzles/result")
      .set("Authorization", `Bearer ${token}`)
      .send(puzzleBody());
    expect(res.status).toBe(200);
    expect(typeof res.body.celebrate).toBe("string");
    expect(res.body.celebrate.length).toBeGreaterThan(0);
    // Must be one of the feedback strings — not some hardcoded English
    const allFeedback = [
      ...TEST_PACK.feedback.celebrate_l1,
      TEST_PACK.feedback.good_effort_l1,
      TEST_PACK.feedback.almost_l1,
    ];
    expect(allFeedback).toContain(res.body.celebrate);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CRITICAL TEST: idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/puzzles/result — idempotency (THE MONEY PATH)", () => {
  it("same idempotency_key: ONE ledger row, is_retry=true, balance unchanged", async () => {
    const key = randomUUID();
    const body = puzzleBody({ idempotency_key: key, used_voice: true });

    // First call — genuine submission
    const r1 = await request(app)
      .post("/api/puzzles/result")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(r1.status).toBe(200);
    expect(r1.body.is_retry).toBe(false);
    const pts1 = r1.body.points_awarded;
    const bal1 = r1.body.balance;

    // Second call — exact same body (network retry)
    const r2 = await request(app)
      .post("/api/puzzles/result")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(r2.status).toBe(200);
    expect(r2.body.is_retry).toBe(true);
    expect(r2.body.points_awarded).toBe(pts1); // same points as original
    expect(r2.body.balance).toBe(bal1); // balance must NOT have changed

    // Exactly one wallet_ledger row with this idempotency_key
    const { rows } = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM wallet_ledger WHERE idempotency_key = $1",
      [key],
    );
    expect(rows[0].cnt).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/substage/complete
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/substage/complete", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/substage/complete")
      .send({ sub_stage_id: SS2 });
    expect(res.status).toBe(401);
  });

  it("below threshold — returns mastered=false with encouragement, not failure language", async () => {
    // SS2 has no puzzle_results → mastery=0 < 0.7
    const res = await request(app)
      .post("/api/substage/complete")
      .set("Authorization", `Bearer ${token}`)
      .send({ sub_stage_id: SS2 });
    expect(res.status).toBe(200);
    expect(res.body.mastered).toBe(false);
    expect(res.body.points_awarded).toBe(0);
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
    // Confirm encouragement copy, not failure language
    expect(res.body.message).not.toMatch(/fail/i);
    expect(res.body.message).not.toMatch(/wrong/i);
    expect(res.body.message).not.toMatch(/incorrect/i);
  });

  it("at or above threshold — mastered=true, awards points, unlocks next sub-stage", async () => {
    // Insert one correct puzzle_result for SS3 → mastery = 100% ≥ 70%
    await pool.query(
      `INSERT INTO puzzle_results
         (user_id, sub_stage_id, puzzle_id, used_voice, correct, transcript, points_awarded)
       VALUES ($1, $2, '9901.3.p1', false, true, 'hello', 5)`,
      [TEST_USER_ID, SS3],
    );

    const res = await request(app)
      .post("/api/substage/complete")
      .set("Authorization", `Bearer ${token}`)
      .send({ sub_stage_id: SS3 });
    expect(res.status).toBe(200);
    expect(res.body.mastered).toBe(true);
    expect(res.body.points_awarded).toBeGreaterThan(0);
    expect(typeof res.body.balance).toBe("number");
    expect(res.body.next_sub_stage_id).toBe(SS4); // next unlocked

    // Progress row for SS4 created with status='not_started'
    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM progress WHERE user_id = $1 AND sub_stage_id = $2",
      [TEST_USER_ID, SS4],
    );
    expect(rows[0]?.status).toBe("not_started");
  });

  it("completing the same sub-stage twice does NOT re-credit the wallet", async () => {
    // SS3 was already completed in the previous test
    const balBefore = (
      await pool.query<{ bal: number }>(
        `SELECT COALESCE(SUM(delta_points), 0)::INT AS bal
         FROM wallet_ledger WHERE user_id = $1`,
        [TEST_USER_ID],
      )
    ).rows[0].bal;

    const res = await request(app)
      .post("/api/substage/complete")
      .set("Authorization", `Bearer ${token}`)
      .send({ sub_stage_id: SS3 });
    expect(res.status).toBe(200);
    expect(res.body.mastered).toBe(true);
    expect(res.body.points_awarded).toBe(0); // no re-credit

    const balAfter = (
      await pool.query<{ bal: number }>(
        `SELECT COALESCE(SUM(delta_points), 0)::INT AS bal
         FROM wallet_ledger WHERE user_id = $1`,
        [TEST_USER_ID],
      )
    ).rows[0].bal;

    expect(balAfter).toBe(balBefore); // balance unchanged
  });
});
