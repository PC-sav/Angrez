/**
 * tests/money.test.ts
 *
 * Money-path hardening — items not covered by robustness.test.ts or audit.test.ts.
 * Covers: MP-3, MP-4, MP-6, MP-8, MP-10.
 *
 * Stage 9904 — normal tests.
 * Stage 9906 — degenerate-points pack (MP-6).
 */

import "dotenv/config";
import { randomUUID, randomInt } from "crypto";
import { readFileSync } from "fs";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import appPool from "../src/lib/db";
import * as learningService from "../src/services/learning";
import app from "../src/app";
import { signJwt } from "../src/services/jwt";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ID = randomUUID();
const USER_PHONE = `+91${randomInt(6_000_000_000, 9_999_999_999)}`;
const STAGE = 9904;
const STAGE_NEG = 9906; // negative-points pack for MP-6
const SS1 = "9904.1"; // MP-3, MP-4, MP-10
const SS_BELOW = "9904.below"; // MP-8: 0.60 mastery (below 0.70)
const SS_AT = "9904.at"; // MP-8: 0.70 mastery (at threshold)
const SS_ABOVE = "9904.above"; // MP-8: 0.80 mastery (above threshold)
const SS_NEG = "9906.1"; // MP-6: negative puzzle_base

const PUZZLE_BASE = 5;
const VOICE_BONUS = 3;

function makePack(stage: number, version: number, extraSS: object[] = []) {
  return {
    stage,
    version,
    language: "hi",
    mastery_threshold: 0.7,
    points: { puzzle_base: PUZZLE_BASE, voice_bonus: VOICE_BONUS,
               sub_stage_complete: 20, sub_stage_perfect_bonus: 10,
               bravery_bonus: 0, daily_open: 0 },
    feedback: { celebrate_l1: ["शाबाश!"], good_effort_l1: "अच्छी कोशिश!",
                 almost_l1: "लगभग!", heard_prefix_l1: "", mic_broken_l1: "",
                 noise_high_l1: "", silence_l1: "", ready_to_listen_l1: "" },
    sub_stages: [
      { id: SS1, title_en: "Money SS1", teach: [], practice: [
          { id: "9904.1.p1", type: "test", open_ended: true }] },
      { id: SS_BELOW, title_en: "Below", teach: [], practice: [
          { id: "9904.below.p1", type: "test", open_ended: true }] },
      { id: SS_AT, title_en: "At threshold", teach: [], practice: [
          { id: "9904.at.p1", type: "test", open_ended: true }] },
      { id: SS_ABOVE, title_en: "Above", teach: [], practice: [
          { id: "9904.above.p1", type: "test", open_ended: true }] },
      ...extraSS,
    ],
  };
}

const DEGENERATE_PACK = {
  stage: STAGE_NEG,
  version: 1,
  language: "hi",
  mastery_threshold: 0.7,
  points: { puzzle_base: -10, voice_bonus: -3,
             sub_stage_complete: 20, sub_stage_perfect_bonus: 10,
             bravery_bonus: 0, daily_open: 0 },
  feedback: { celebrate_l1: ["ok"], good_effort_l1: "ok", almost_l1: "ok",
               heard_prefix_l1: "", mic_broken_l1: "", noise_high_l1: "",
               silence_l1: "", ready_to_listen_l1: "" },
  sub_stages: [
    { id: SS_NEG, title_en: "Neg SS", teach: [], practice: [
        { id: "9906.1.p1", type: "test", open_ended: true }] },
  ],
};

let token: string;

type PoolClient = { release: () => void };
type PoolWithOptions = { options: { connectionTimeoutMillis: number } };

function auth() { return { Authorization: `Bearer ${token}` }; }

function puzzleBody(overrides: Record<string, unknown> = {}) {
  return { sub_stage_id: SS1, puzzle_id: "9904.1.p1",
           transcript: "anything", used_voice: false,
           idempotency_key: randomUUID(), ...overrides };
}

async function ledgerBalance(): Promise<number> {
  const { rows } = await appPool.query<{ bal: number }>(
    "SELECT COALESCE(SUM(delta_points), 0)::INT AS bal FROM wallet_ledger WHERE user_id = $1",
    [USER_ID],
  );
  return rows[0].bal;
}

beforeAll(async () => {
  await appPool.query(
    `INSERT INTO users (id, phone, language, level)
     VALUES ($1, $2, 'hi', 1) ON CONFLICT (id) DO NOTHING`,
    [USER_ID, USER_PHONE],
  );
  await appPool.query(
    `INSERT INTO content_packs (stage, version, language, json, published_at)
     VALUES ($1, 1, 'hi', $2::jsonb, now())
     ON CONFLICT (stage, version, language)
     DO UPDATE SET json = EXCLUDED.json, published_at = EXCLUDED.published_at`,
    [STAGE, JSON.stringify(makePack(STAGE, 1))],
  );
  await appPool.query(
    `INSERT INTO content_packs (stage, version, language, json, published_at)
     VALUES ($1, 1, 'hi', $2::jsonb, now())
     ON CONFLICT (stage, version, language)
     DO UPDATE SET json = EXCLUDED.json, published_at = EXCLUDED.published_at`,
    [STAGE_NEG, JSON.stringify(DEGENERATE_PACK)],
  );
  token = signJwt({ sub: USER_ID, phone: USER_PHONE });
});

afterAll(async () => {
  await appPool.query("DELETE FROM puzzle_results WHERE user_id = $1", [USER_ID]);
  await appPool.query("DELETE FROM progress WHERE user_id = $1", [USER_ID]);
  await appPool.query("DELETE FROM content_packs WHERE stage IN ($1, $2) AND language = 'hi'",
                      [STAGE, STAGE_NEG]);
  await appPool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// MP-3  Retry-after-dropped-response contract
// ─────────────────────────────────────────────────────────────────────────────

describe("MP-3 — Client-side idempotency_key survives a dropped response", () => {
  it("retry with the same key after a 'lost' response returns original award, no second credit", async () => {
    // The client generates the key BEFORE making the request (the invariant).
    const key = randomUUID();
    const body = puzzleBody({ idempotency_key: key });

    const balBefore = await ledgerBalance();

    // First request — response deliberately ignored (simulates network drop)
    await request(app).post("/api/puzzles/result").set(auth()).send(body);

    // Retry — the only response the client has
    const retryRes = await request(app).post("/api/puzzles/result").set(auth()).send(body);
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.is_retry).toBe(true);
    expect(retryRes.body.points_awarded).toBe(PUZZLE_BASE);

    // Balance increased exactly once, not twice
    const balAfter = await ledgerBalance();
    expect(balAfter).toBe(balBefore + PUZZLE_BASE);

    const { rows } = await appPool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM wallet_ledger WHERE idempotency_key = $1",
      [key],
    );
    expect(rows[0].cnt).toBe(1);
  });

  it("static: idempotency_key is read from req.body — the client owns key generation", () => {
    const routeSrc = readFileSync("/Users/Pratap1/angrez/src/routes/learning.ts", "utf-8");
    // The key is destructured from req.body, never generated server-side for /puzzles/result
    expect(routeSrc).toMatch(/idempotency_key[\s\S]*?req\.body/);
    // No server-side randomUUID() assigned to idempotency_key in the route
    expect(routeSrc).not.toMatch(/idempotency_key\s*=\s*randomUUID/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MP-4  Award/response atomicity under pool exhaustion
// ─────────────────────────────────────────────────────────────────────────────

describe("MP-4 — Pool exhaustion: 503 with no orphaned credit", () => {
  it("exhausted pool on /puzzles/result → 503, no ledger row written", async () => {
    const opts = (appPool as unknown as PoolWithOptions).options;
    const origTimeout = opts.connectionTimeoutMillis;

    const key = randomUUID();
    const held: PoolClient[] = [];

    // Acquire all 5 slots at normal timeout (avoids timing out our own connects).
    for (let i = 0; i < 5; i++) {
      held.push(await appPool.connect());
    }

    // Now reduce the timeout so the app's next connect attempt fails quickly.
    opts.connectionTimeoutMillis = 400;

    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(app)
        .post("/api/puzzles/result")
        .set(auth())
        .send(puzzleBody({ idempotency_key: key }));
    } finally {
      // Restore before releasing so no other concurrent waiters see the short timeout.
      opts.connectionTimeoutMillis = origTimeout;
      held.forEach((c) => c.release());
    }

    expect(res!.status).toBe(503);
    expect(res!.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(res!.headers["retry-after"]).toBe("5");

    // No orphaned credit — checked after connections are released.
    const { rows } = await appPool.query(
      "SELECT id FROM wallet_ledger WHERE idempotency_key = $1",
      [key],
    );
    expect(rows.length).toBe(0);
  }, 12000);
});

// ─────────────────────────────────────────────────────────────────────────────
// MP-6  Degenerate point values: negative pack values → 0 award, no neg ledger
// ─────────────────────────────────────────────────────────────────────────────

describe("MP-6 — Degenerate point values never reach the ledger", () => {
  it("pack with puzzle_base=-10 awards 0 points, no negative delta in wallet_ledger", async () => {
    const key = randomUUID();
    const res = await request(app)
      .post("/api/puzzles/result")
      .set(auth())
      .send({
        sub_stage_id: SS_NEG,
        puzzle_id: "9906.1.p1",
        transcript: "anything",
        used_voice: false,
        idempotency_key: key,
      });

    expect(res.status).toBe(200);
    expect(res.body.points_awarded).toBe(0); // clamped from -10
    expect(res.body.balance).toBeGreaterThanOrEqual(0); // balance never negative

    // No negative delta row exists
    const { rows } = await appPool.query(
      "SELECT delta_points FROM wallet_ledger WHERE idempotency_key = $1",
      [key],
    );
    // Row should have delta_points = 0 (not -10)
    if (rows.length > 0) {
      expect(rows[0].delta_points).toBeGreaterThanOrEqual(0);
    }
  });

  it("pack with puzzle_base=-10, used_voice=true awards 0 points (voice_bonus=-3 also clamped)", async () => {
    const key = randomUUID();
    const res = await request(app)
      .post("/api/puzzles/result")
      .set(auth())
      .send({
        sub_stage_id: SS_NEG,
        puzzle_id: "9906.1.p1",
        transcript: "hello world",
        used_voice: true,
        idempotency_key: key,
      });

    expect(res.status).toBe(200);
    expect(res.body.points_awarded).toBe(0); // clamped from (-10 + -3) = -13
  });

  it("client-sent points field is ignored (server computes from pack)", async () => {
    const res = await request(app)
      .post("/api/puzzles/result")
      .set(auth())
      .send(puzzleBody({ points: 9999, delta_points: 9999, used_voice: false }));
    expect(res.status).toBe(200);
    expect(res.body.points_awarded).toBe(PUZZLE_BASE); // server-computed
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MP-8  Mastery boundary: exactly at, below, and above 0.70
// ─────────────────────────────────────────────────────────────────────────────

describe("MP-8 — Mastery boundary at ≥ 0.70 (>= semantics)", () => {
  // Insert exactly N correct + M incorrect puzzle_results directly.
  async function insertResults(
    subStageId: string,
    puzzleId: string,
    correct: number,
    incorrect: number,
  ) {
    for (let i = 0; i < correct; i++) {
      await appPool.query(
        `INSERT INTO puzzle_results (user_id, sub_stage_id, puzzle_id, used_voice, correct, transcript, points_awarded)
         VALUES ($1, $2, $3, false, true, 'correct', 5)`,
        [USER_ID, subStageId, puzzleId],
      );
    }
    for (let i = 0; i < incorrect; i++) {
      await appPool.query(
        `INSERT INTO puzzle_results (user_id, sub_stage_id, puzzle_id, used_voice, correct, transcript, points_awarded)
         VALUES ($1, $2, $3, false, false, 'wrong', 0)`,
        [USER_ID, subStageId, puzzleId],
      );
    }
  }

  it("6/10 correct = 0.60 → mastered=false (below 0.70)", async () => {
    await insertResults(SS_BELOW, "9904.below.p1", 6, 4);
    const res = await request(app)
      .post("/api/substage/complete")
      .set(auth())
      .send({ sub_stage_id: SS_BELOW });
    expect(res.status).toBe(200);
    expect(res.body.mastered).toBe(false);
    expect(res.body.points_awarded).toBe(0);
  });

  it("7/10 correct = exactly 0.70 → mastered=true (boundary: >= unlocks)", async () => {
    await insertResults(SS_AT, "9904.at.p1", 7, 3);
    const res = await request(app)
      .post("/api/substage/complete")
      .set(auth())
      .send({ sub_stage_id: SS_AT });
    expect(res.status).toBe(200);
    // mastery = 7/10 = 0.70 >= threshold 0.70 → mastered
    expect(res.body.mastered).toBe(true);
    expect(res.body.points_awarded).toBeGreaterThan(0);
  });

  it("8/10 correct = 0.80 → mastered=true (above 0.70)", async () => {
    await insertResults(SS_ABOVE, "9904.above.p1", 8, 2);
    const res = await request(app)
      .post("/api/substage/complete")
      .set(auth())
      .send({ sub_stage_id: SS_ABOVE });
    expect(res.status).toBe(200);
    expect(res.body.mastered).toBe(true);
  });

  it("mastery threshold rule is >=, not > (boundary pinned)", () => {
    // The completeSubStage service uses: if (mastery < threshold) → not mastered
    // Equivalent: mastered when mastery >= threshold.
    // This static check confirms the rule is documented and won't silently shift.
    const src = readFileSync("/Users/Pratap1/angrez/src/services/learning.ts", "utf-8");
    expect(src).toMatch(/if\s*\(\s*mastery\s*<\s*threshold\s*\)/);
    // Confirm there is no `<=` variant that would change the boundary
    expect(src).not.toMatch(/mastery\s*<=\s*threshold/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MP-10  Read path equals write path
// ─────────────────────────────────────────────────────────────────────────────

describe("MP-10 — wallet_balances view equals SUM(wallet_ledger)", () => {
  it("wallet_balances view returns the same value as raw SUM(delta_points)", async () => {
    // Ensure at least one ledger entry for this user (from prior tests above).
    const { rows: viewRows } = await appPool.query<{ balance: number }>(
      "SELECT balance FROM wallet_balances WHERE user_id = $1",
      [USER_ID],
    );
    const { rows: sumRows } = await appPool.query<{ bal: number }>(
      "SELECT COALESCE(SUM(delta_points), 0)::INT AS bal FROM wallet_ledger WHERE user_id = $1",
      [USER_ID],
    );

    const viewBalance = viewRows[0]?.balance ?? 0;
    const rawSum = sumRows[0].bal;

    expect(viewBalance).toBe(rawSum);
  });

  it("wallet_balances view is consistent after multiple ledger inserts", async () => {
    const before = await ledgerBalance();

    // Insert two ledger rows directly (simulating two separate events)
    const k1 = randomUUID();
    const k2 = randomUUID();
    await appPool.query(
      "INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key) VALUES ($1, 7, 'test_mp10', $2)",
      [USER_ID, k1],
    );
    await appPool.query(
      "INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key) VALUES ($1, 13, 'test_mp10', $2)",
      [USER_ID, k2],
    );

    const { rows: viewRows } = await appPool.query<{ balance: number }>(
      "SELECT balance FROM wallet_balances WHERE user_id = $1",
      [USER_ID],
    );
    const viewBalance = viewRows[0]?.balance ?? 0;
    const rawSum = await ledgerBalance();

    expect(viewBalance).toBe(rawSum);
    expect(viewBalance).toBe(before + 7 + 13);
  });

  it("balance returned by the API equals the view balance", async () => {
    const res = await request(app)
      .post("/api/puzzles/result")
      .set(auth())
      .send(puzzleBody({ used_voice: false }));
    expect(res.status).toBe(200);

    const apiBalance = res.body.balance;
    const { rows } = await appPool.query<{ balance: number }>(
      "SELECT balance FROM wallet_balances WHERE user_id = $1",
      [USER_ID],
    );
    expect(apiBalance).toBe(rows[0].balance);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MP-9  No direct balance writes — static source guard
// ─────────────────────────────────────────────────────────────────────────────

describe("MP-9 — No direct writes to wallet_ledger or wallet_balances in src/", () => {
  it("static: src/ contains no UPDATE wallet_ledger (trigger covers it, but code must not attempt)", () => {
    const { execSync } = require("child_process");
    const out = execSync(
      'grep -rn --include="*.ts" "UPDATE\\s.*wallet_ledger" /Users/Pratap1/angrez/src/ || true',
    ).toString();
    expect(out.trim()).toBe("");
  });

  it("static: src/ contains no DELETE FROM wallet_ledger", () => {
    const { execSync } = require("child_process");
    const out = execSync(
      'grep -rn --include="*.ts" "DELETE\\s.*wallet_ledger" /Users/Pratap1/angrez/src/ || true',
    ).toString();
    expect(out.trim()).toBe("");
  });

  it("static: src/ contains no writes to wallet_balances (it is a view)", () => {
    const { execSync } = require("child_process");
    const out = execSync(
      'grep -rn --include="*.ts" "INSERT\\|UPDATE\\|DELETE" /Users/Pratap1/angrez/src/ | grep "wallet_balances" || true',
    ).toString();
    expect(out.trim()).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MP-1  Parallel-race idempotency + 503/500 routing
// ─────────────────────────────────────────────────────────────────────────────

describe("MP-1 — parallel duplicate idempotency_key", () => {
  it("(a) two parallel identical requests → ONE ledger row; both responses return the same award", async () => {
    const key = randomUUID();
    const body = puzzleBody({ idempotency_key: key });

    const [r1, r2] = await Promise.all([
      request(app).post("/api/puzzles/result").set(auth()).send(body),
      request(app).post("/api/puzzles/result").set(auth()).send(body),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.points_awarded).toBe(r2.body.points_awarded);

    const { rows } = await appPool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM wallet_ledger WHERE idempotency_key = $1",
      [key],
    );
    expect(rows[0].cnt).toBe(1);
  });

  it("(b) transient db error → 503, not 500 or 401", async () => {
    const opts = (appPool as unknown as PoolWithOptions).options;
    const origTimeout = opts.connectionTimeoutMillis;
    const held: PoolClient[] = [];
    for (let i = 0; i < 5; i++) held.push(await appPool.connect());
    opts.connectionTimeoutMillis = 400;

    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(app)
        .post("/api/puzzles/result")
        .set(auth())
        .send(puzzleBody());
    } finally {
      opts.connectionTimeoutMillis = origTimeout;
      held.forEach((c) => c.release());
    }

    expect(res!.status).toBe(503);
    expect(res!.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(res!.headers["retry-after"]).toBe("5");
  }, 12000);

  it("(c) after a 503, retry with the SAME key → zero additional ledger rows, original award returned", async () => {
    // Step 1: successful write so there IS an existing row to find on retry.
    const key = randomUUID();
    const body = puzzleBody({ idempotency_key: key });
    const first = await request(app).post("/api/puzzles/result").set(auth()).send(body);
    expect(first.status).toBe(200);
    const originalAward = first.body.points_awarded as number;

    // Step 2: pool exhausted → 503 for the same key.
    // The existing row is untouched; the pool failure happens before any DB write.
    const opts = (appPool as unknown as PoolWithOptions).options;
    const origTimeout = opts.connectionTimeoutMillis;
    const held: PoolClient[] = [];
    for (let i = 0; i < 5; i++) held.push(await appPool.connect());
    opts.connectionTimeoutMillis = 400;
    let errRes: Awaited<ReturnType<typeof request>>;
    try {
      errRes = await request(app).post("/api/puzzles/result").set(auth()).send(body);
    } finally {
      opts.connectionTimeoutMillis = origTimeout;
      held.forEach((c) => c.release());
    }
    expect(errRes!.status).toBe(503);

    // Step 3: retry after 503 — must find the original row, no second credit.
    const retry = await request(app).post("/api/puzzles/result").set(auth()).send(body);
    expect(retry.status).toBe(200);
    expect(retry.body.is_retry).toBe(true);
    expect(retry.body.points_awarded).toBe(originalAward);

    const { rows } = await appPool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM wallet_ledger WHERE idempotency_key = $1",
      [key],
    );
    expect(rows[0].cnt).toBe(1);
  }, 15000);

  it("(d) logic db error → 500, not 503; no Retry-After header", async () => {
    // Spy on recordPuzzleResult so requireAuth runs normally (auth unaffected)
    // and only the service call throws a non-transient error.
    const logicErr = Object.assign(
      new Error("relation does not exist"),
      { code: "42P01" }, // undefined_table — absent from TRANSIENT_PG_CODES
    );
    const spy = vi
      .spyOn(learningService, "recordPuzzleResult")
      .mockRejectedValueOnce(logicErr as never);

    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(app)
        .post("/api/puzzles/result")
        .set(auth())
        .send(puzzleBody());
    } finally {
      spy.mockRestore();
    }

    expect(res!.status).toBe(500);
    expect(res!.body.error.code).toBe("INTERNAL");
    expect(res!.headers["retry-after"]).toBeUndefined();
  });
});
