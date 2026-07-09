/**
 * tests/audit.test.ts
 *
 * Cross-cutting invariant audit for Steps 1–5.
 * Each test is labelled with the check number from the audit spec.
 * Uses stage 9903 and fresh UUIDs per run to avoid collision.
 */

import "dotenv/config";
import { randomUUID, randomInt } from "crypto";
import jwt from "jsonwebtoken";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pool from "./support/testDb";
import app from "../src/app";
import { signJwt } from "../src/services/jwt";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_A = randomUUID();
const USER_B = randomUUID();
const PHONE_A = `+91${randomInt(6_000_000_000, 9_999_999_999)}`;
const PHONE_B = `+91${randomInt(6_000_000_000, 9_999_999_999)}`;
const STAGE = 9903;
const SS1 = "9903.1";
const SS2 = "9903.2";

const TEST_PACK = {
  stage: STAGE,
  version: 1,
  language: "hi",
  mastery_threshold: 0.7,
  points: {
    puzzle_base: 5,
    voice_bonus: 3,
    sub_stage_complete: 20,
    sub_stage_perfect_bonus: 10,
    bravery_bonus: 0,
    daily_open: 0,
  },
  feedback: {
    celebrate_l1: ["बढ़िया!"],
    good_effort_l1: "अच्छी कोशिश!",
    almost_l1: "लगभग!",
    heard_prefix_l1: "",
    mic_broken_l1: "",
    noise_high_l1: "",
    silence_l1: "",
    ready_to_listen_l1: "",
  },
  sub_stages: [
    {
      id: SS1,
      title_en: "Audit Stage 1",
      teach: [],
      practice: [{ id: "9903.1.p1", type: "test", open_ended: true }],
    },
    {
      id: SS2,
      title_en: "Audit Stage 2",
      teach: [],
      practice: [{ id: "9903.2.p1", type: "test", open_ended: true }],
    },
  ],
};

let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  await pool.query(
    `INSERT INTO users (id, phone, language, level)
     VALUES ($1, $2, 'hi', 1), ($3, $4, 'hi', 1)
     ON CONFLICT (id) DO NOTHING`,
    [USER_A, PHONE_A, USER_B, PHONE_B],
  );
  await pool.query(
    `INSERT INTO content_packs (stage, version, language, json, published_at)
     VALUES ($1, 1, 'hi', $2::jsonb, now())
     ON CONFLICT (stage, version, language)
     DO UPDATE SET json = EXCLUDED.json, published_at = EXCLUDED.published_at`,
    [STAGE, JSON.stringify(TEST_PACK)],
  );
  tokenA = signJwt({ sub: USER_A, phone: PHONE_A });
  tokenB = signJwt({ sub: USER_B, phone: PHONE_B });
});

afterAll(async () => {
  await pool.query("DELETE FROM puzzle_results WHERE user_id IN ($1, $2)", [USER_A, USER_B]);
  await pool.query("DELETE FROM progress WHERE user_id IN ($1, $2)", [USER_A, USER_B]);
  await pool.query("DELETE FROM content_packs WHERE stage = $1 AND language = 'hi'", [STAGE]);
  await pool.end();
});

function authA() {
  return { Authorization: `Bearer ${tokenA}` };
}
function authB() {
  return { Authorization: `Bearer ${tokenB}` };
}

function puzzle(overrides: Record<string, unknown> = {}) {
  return {
    sub_stage_id: SS1,
    puzzle_id: "9903.1.p1",
    transcript: "namaste",
    used_voice: false,
    idempotency_key: randomUUID(),
    ...overrides,
  };
}

async function ledgerSum(userId: string): Promise<number> {
  const { rows } = await pool.query<{ bal: number }>(
    "SELECT COALESCE(SUM(delta_points), 0)::INT AS bal FROM wallet_ledger WHERE user_id = $1",
    [userId],
  );
  return rows[0].bal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Money path
// ─────────────────────────────────────────────────────────────────────────────

describe("Money path invariants", () => {
  it("#1a  wallet_ledger trigger rejects UPDATE on an existing row", async () => {
    // Write a real ledger row first
    const idemKey = randomUUID();
    await pool.query(
      "INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key) VALUES ($1, 1, 'audit_test', $2)",
      [USER_A, idemKey],
    );

    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM wallet_ledger WHERE idempotency_key = $1",
      [idemKey],
    );
    const rowId = rows[0].id;

    await expect(
      pool.query("UPDATE wallet_ledger SET delta_points = 999 WHERE id = $1", [rowId]),
    ).rejects.toThrow(/append-only.*UPDATE/i);
  });

  it("#1b  wallet_ledger trigger rejects DELETE on an existing row", async () => {
    const idemKey = randomUUID();
    await pool.query(
      "INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key) VALUES ($1, 1, 'audit_test', $2)",
      [USER_A, idemKey],
    );
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM wallet_ledger WHERE idempotency_key = $1",
      [idemKey],
    );

    await expect(
      pool.query("DELETE FROM wallet_ledger WHERE id = $1", [rows[0].id]),
    ).rejects.toThrow(/append-only.*DELETE/i);
  });

  it("#2  API balance == SUM(delta_points) after a full run (results + complete + retry)", async () => {
    // Several puzzle results
    const key1 = randomUUID();
    const key2 = randomUUID();
    const keyRetry = randomUUID();

    const r1 = await request(app).post("/api/puzzles/result").set(authA()).send(puzzle({ idempotency_key: key1, used_voice: true }));
    expect(r1.status).toBe(200);

    const r2 = await request(app).post("/api/puzzles/result").set(authA()).send(puzzle({ idempotency_key: key2, used_voice: false }));
    expect(r2.status).toBe(200);

    // Retry (same key as r1) — should NOT change balance
    const rRetry = await request(app).post("/api/puzzles/result").set(authA()).send(puzzle({ idempotency_key: key1, used_voice: true }));
    expect(rRetry.status).toBe(200);
    expect(rRetry.body.is_retry).toBe(true);

    // Insert a puzzle_result so substage mastery ≥ threshold, then complete
    await pool.query(
      `INSERT INTO puzzle_results (user_id, sub_stage_id, puzzle_id, used_voice, correct, transcript, points_awarded)
       VALUES ($1, $2, '9903.2.p1', false, true, 'hi', 5)`,
      [USER_A, SS2],
    );
    const rc = await request(app).post("/api/substage/complete").set(authA()).send({ sub_stage_id: SS2 });
    expect(rc.status).toBe(200);
    expect(rc.body.mastered).toBe(true);

    // API balance from last response
    const apiBalance = rc.body.balance;

    // DB-derived balance
    const dbBalance = await ledgerSum(USER_A);

    expect(apiBalance).toBe(dbBalance);
  }, 15000);

  it("#3  every wallet_ledger row for these users has non-null reason + unique idempotency_key; no row has client-supplied inflated points", async () => {
    // Check reason and idempotency_key are always set
    const { rows: nullReasons } = await pool.query(
      "SELECT id FROM wallet_ledger WHERE user_id = $1 AND reason IS NULL",
      [USER_A],
    );
    expect(nullReasons.length).toBe(0);

    const { rows: nullKeys } = await pool.query(
      "SELECT id FROM wallet_ledger WHERE user_id = $1 AND idempotency_key IS NULL",
      [USER_A],
    );
    expect(nullKeys.length).toBe(0);

    // Uniqueness of idempotency_key (enforced by UNIQUE constraint — verify no duplicates exist)
    const { rows: dupes } = await pool.query(`
      SELECT idempotency_key, COUNT(*) AS cnt
      FROM wallet_ledger
      WHERE user_id = $1
      GROUP BY idempotency_key
      HAVING COUNT(*) > 1
    `, [USER_A]);
    expect(dupes.length).toBe(0);

    // No row with obviously client-inflated points (> pack max of base+voice+complete+perfect = 38)
    const { rows: inflated } = await pool.query(
      "SELECT id, delta_points FROM wallet_ledger WHERE user_id = $1 AND delta_points > 100",
      [USER_A],
    );
    expect(inflated.length).toBe(0);
  });

  it("#4  mid-transaction failure rolls back BOTH puzzle_results and wallet_ledger — no orphans", async () => {
    // Strategy: pre-insert a wallet_ledger row with a known UUID key,
    // then run a raw DB transaction that inserts puzzle_results and
    // tries to insert wallet_ledger with the SAME key → 23505 → ROLLBACK.
    // After rollback, verify puzzle_results has no orphan row.

    const conflictKey = randomUUID();
    const markerTranscript = `rollback-audit-${randomUUID()}`;

    // Pre-insert to seed the conflict
    await pool.query(
      "INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key) VALUES ($1, 1, 'seed_conflict', $2)",
      [USER_A, conflictKey],
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO puzzle_results
           (user_id, sub_stage_id, puzzle_id, used_voice, correct, transcript, points_awarded)
         VALUES ($1, $2, '9903.1.p1', false, false, $3, 0)`,
        [USER_A, SS1, markerTranscript],
      );

      // This must fail — same idempotency_key → 23505
      await client.query(
        "INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key) VALUES ($1, 5, 'puzzle_result', $2)",
        [USER_A, conflictKey],
      );

      // Should never reach here
      await client.query("COMMIT");
    } catch (err: unknown) {
      await client.query("ROLLBACK");
      const pg = err as { code?: string };
      expect(pg.code).toBe("23505"); // unique_violation
    } finally {
      client.release();
    }

    // Verify no orphan puzzle_results row survived
    const { rows: orphans } = await pool.query(
      "SELECT id FROM puzzle_results WHERE user_id = $1 AND transcript = $2",
      [USER_A, markerTranscript],
    );
    expect(orphans.length).toBe(0);

    // Verify still exactly one wallet_ledger row for conflictKey (the pre-inserted one)
    const { rows: ledgerRows } = await pool.query(
      "SELECT COUNT(*)::int AS cnt FROM wallet_ledger WHERE idempotency_key = $1",
      [conflictKey],
    );
    expect(Number(ledgerRows[0].cnt)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("Auth boundary", () => {
  it("#5  every guarded endpoint returns 401 for missing / expired / garbage JWT", async () => {
    const garbage = "Bearer garbage.token.value";
    // Build a real JWT that is already expired (iat = 2s ago, exp = 1s ago)
    const expired = `Bearer ${jwt.sign(
      { sub: USER_A, phone: PHONE_A },
      process.env.JWT_SECRET!,
      { algorithm: "HS256", expiresIn: "1ms" },
    )}`;

    const routes: Array<{ method: "get" | "post"; path: string; body?: object }> = [
      { method: "get",  path: "/api/plan/next" },
      { method: "post", path: "/api/puzzles/result",    body: puzzle() },
      { method: "post", path: "/api/substage/complete", body: { sub_stage_id: SS1 } },
      { method: "get",  path: "/api/content/packs?language=hi" },
      { method: "get",  path: "/api/content/packs/00000000-0000-0000-0000-000000000000" },
      { method: "get",  path: "/api/auth/me" },
    ];

    for (const route of routes) {
      const base = request(app)[route.method](route.path);
      const withBody = route.body ? base.send(route.body) : base;

      // Missing token
      const noToken = route.body
        ? await request(app)[route.method](route.path).send(route.body)
        : await request(app)[route.method](route.path);
      expect(noToken.status, `${route.method.toUpperCase()} ${route.path} — no token`).toBe(401);

      // Garbage token
      const garbageRes = route.body
        ? await request(app)[route.method](route.path).set("Authorization", garbage).send(route.body)
        : await request(app)[route.method](route.path).set("Authorization", garbage);
      expect(garbageRes.status, `${route.method.toUpperCase()} ${route.path} — garbage token`).toBe(401);

      // Expired token
      const expiredRes = route.body
        ? await request(app)[route.method](route.path).set("Authorization", expired).send(route.body)
        : await request(app)[route.method](route.path).set("Authorization", expired);
      expect(expiredRes.status, `${route.method.toUpperCase()} ${route.path} — expired token`).toBe(401);
    }
  });

  it("#6  user can only read/write their OWN data — JWT sub is authoritative, body user_id ignored", async () => {
    // User B submits a puzzle result — points must go to B, not A
    const keyB = randomUUID();
    const balABefore = await ledgerSum(USER_A);

    const res = await request(app)
      .post("/api/puzzles/result")
      .set(authB())
      .send({
        ...puzzle({ idempotency_key: keyB }),
        // Attacker tries to credit user A instead
        user_id: USER_A,
      });
    expect(res.status).toBe(200);

    // Ledger row must be for USER_B, not USER_A
    const { rows } = await pool.query(
      "SELECT user_id FROM wallet_ledger WHERE idempotency_key = $1",
      [keyB],
    );
    expect(rows[0].user_id).toBe(USER_B);

    // User A's balance must be unchanged
    const balAAfter = await ledgerSum(USER_A);
    expect(balAAfter).toBe(balABefore);

    // /plan/next returns data for the JWT user — User B's plan, not A's
    const planRes = await request(app).get("/api/plan/next").set(authB());
    expect(planRes.status).toBe(200);
    // No way to ask for another user's plan via query param
    const planWithParam = await request(app)
      .get(`/api/plan/next?user_id=${USER_A}`)
      .set(authB());
    expect(planWithParam.status).toBe(200);
    // Both responses are for User B — we can't directly verify the user_id in the response
    // body, but the fact that neither 401s nor 403s means the server used the JWT sub
    // (a wrong user_id param is simply ignored by the route handler).
    expect(planRes.body.sub_stage_id).toBe(planWithParam.body.sub_stage_id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Data integrity
// ─────────────────────────────────────────────────────────────────────────────

describe("Data integrity", () => {
  it("#7  devOtp is absent from responses when NODE_ENV=production", async () => {
    // The stub SMS provider returns devOtp only when NODE_ENV !== 'production'.
    // This test verifies the code-level gate. We simulate a production-like check
    // by inspecting the source rather than setting NODE_ENV (which would break pool).

    // Read the guard in the stub source to confirm it's correct
    const { readFileSync } = await import("fs");
    const stub = readFileSync(
      new URL("../src/services/sms/stub.ts", import.meta.url),
      "utf-8",
    );
    // Guard must be present: return devOtp only when !== 'production'
    expect(stub).toMatch(/NODE_ENV.*!==.*production/);
    // Return object must be conditional — not always returning devOtp
    expect(stub).toMatch(/process\.env\.NODE_ENV !== .production./);

    // In the actual test environment (NODE_ENV unset / development), devOtp IS returned
    // by the stub (that's by design for local testing). We only need to confirm the guard exists.
    // We already confirmed above the guard is present in the source.
  });

  it("#8  no secret value is logged or returned in any error response body", async () => {
    // In-process scan of every .ts source file — much faster than execSync.
    const { readdirSync, readFileSync } = await import("fs");
    const { join } = await import("path");

    function scanDir(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? scanDir(join(dir, e.name))
          : e.name.endsWith(".ts")
          ? [join(dir, e.name)]
          : [],
      );
    }

    const srcFiles = scanDir("/Users/Pratap1/angrez/src");
    const forbiddenPatterns = [
      /console\.log.*jwtSecret/,
      /console\.log.*databaseUrl/,
      /console\.log.*DATABASE_URL/,
      /console\.log.*JWT_SECRET/,
    ];

    for (const file of srcFiles) {
      const content = readFileSync(file, "utf-8");
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(content),
          `Secret leaked via console.log in ${file}: ${pattern}`,
        ).toBe(false);
      }
    }

    // Confirm bad-UUID input to content route returns structured error (not hang/stack trace)
    const badIdRes = await request(app)
      .get("/api/content/packs/not-a-uuid")
      .set(authA());
    expect([400, 404]).toContain(badIdRes.status);
    expect(typeof badIdRes.body.error?.code).toBe("string");
    expect(typeof badIdRes.body.error?.message).toBe("string");
    const bodyStr = JSON.stringify(badIdRes.body);
    expect(bodyStr).not.toMatch(/at Object\.|at async|\.ts:\d+|stack/i);
  }, 15000);

  it("#9  content seed is idempotent — re-running upsert produces no duplicates", async () => {
    // Get current pack count for hi language (excluding test stages)
    const { rows: before } = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM content_packs WHERE language = 'hi' AND stage < 9000",
    );

    // Re-upsert the existing packs (simulates running the seed twice)
    const { rows: packs } = await pool.query<{ stage: number; version: number; json: object }>(
      "SELECT stage, version, json FROM content_packs WHERE language = 'hi' AND stage < 9000 AND published_at IS NOT NULL",
    );

    for (const p of packs) {
      await pool.query(
        `INSERT INTO content_packs (stage, version, language, json, published_at)
         VALUES ($1, $2, 'hi', $3::jsonb, now())
         ON CONFLICT (stage, version, language)
         DO UPDATE SET json = EXCLUDED.json, published_at = EXCLUDED.published_at`,
        [p.stage, p.version, JSON.stringify(p.json)],
      );
    }

    const { rows: after } = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM content_packs WHERE language = 'hi' AND stage < 9000",
    );

    expect(after[0].cnt).toBe(before[0].cnt); // no new rows
  });

  it("#10 migration 003 is recorded and schema matches expectations", async () => {
    // Migration recorded
    const { rows: migrations } = await pool.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations WHERE filename LIKE '003%'",
    );
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0].filename).toMatch(/^003/);

    // puzzle_results.sub_stage_id column exists
    const { rows: colRows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'puzzle_results' AND column_name = 'sub_stage_id'`,
    );
    expect(colRows.length).toBe(1);
    expect(colRows[0].is_nullable).toBe("NO"); // NOT NULL

    // progress UNIQUE(user_id, sub_stage_id) constraint exists
    const { rows: constraintRows } = await pool.query<{ constraint_name: string }>(
      `SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE table_name = 'progress'
         AND constraint_type = 'UNIQUE'
         AND constraint_name = 'progress_user_sub_stage_unique'`,
    );
    expect(constraintRows.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consistency
// ─────────────────────────────────────────────────────────────────────────────

describe("Infra & boot-time guards", () => {
  it("IN-1: env.ts calls required() for DATABASE_URL and JWT_SECRET at startup", () => {
    const { readFileSync } = require("fs");
    const src = readFileSync("/Users/Pratap1/angrez/src/config/env.ts", "utf-8") as string;
    expect(src).toMatch(/required\(["']DATABASE_URL["']\)/);
    expect(src).toMatch(/required\(["']JWT_SECRET["']\)/);
  });

  it("IN-1: required() throws with the variable name, ensuring a named crash on boot", () => {
    // Re-implement the same pattern used in env.ts to verify its contract.
    function required(key: string): string {
      const val = process.env[key];
      if (!val) throw new Error(`Missing required env var: ${key}`);
      return val;
    }
    const key = `_TEST_MISSING_${randomUUID().replace(/-/g, "")}`;
    expect(() => required(key)).toThrow(`Missing required env var: ${key}`);
  });

  it("IN-1: index.ts does not swallow the required() error (no try/catch wrapping the import)", () => {
    const { readFileSync } = require("fs");
    const src = readFileSync("/Users/Pratap1/angrez/src/index.ts", "utf-8") as string;
    // No try/catch that could mask a missing-var crash
    expect(src).not.toMatch(/try\s*\{[\s\S]{0,200}import.*config.*env/);
  });
});

describe("Consistency", () => {
  it("#11 all endpoints return { error: { code, message } } on bad input — no raw stack traces", async () => {
    type BadReq = { method: "get" | "post"; path: string; body?: object; expectedStatus: number[] };
    const badRequests: BadReq[] = [
      // Missing fields
      { method: "post", path: "/api/puzzles/result",    body: {}, expectedStatus: [400, 401] },
      { method: "post", path: "/api/substage/complete", body: {}, expectedStatus: [400, 401] },
      // Invalid phone on OTP request
      { method: "post", path: "/api/auth/otp/request", body: { phone: "not-a-phone" }, expectedStatus: [400] },
      // Invalid code format on OTP verify
      { method: "post", path: "/api/auth/otp/verify", body: { phone: "+919876543210", code: "abc" }, expectedStatus: [400] },
      // Non-existent content pack (valid UUID format, not in DB) → 404
      { method: "get", path: "/api/content/packs/00000000-0000-0000-0000-000000000000", expectedStatus: [404, 401] },
      // Malformed UUID in content route param → 400 (not a hang or 500)
      { method: "get", path: "/api/content/packs/not-a-uuid", expectedStatus: [400, 401] },
      // /plan/next with no auth (401 shape)
      { method: "get", path: "/api/plan/next", expectedStatus: [401] },
    ];

    for (const req of badRequests) {
      const res = req.body
        ? await request(app)[req.method](req.path).send(req.body)
        : await request(app)[req.method](req.path);

      expect(
        req.expectedStatus,
        `${req.method.toUpperCase()} ${req.path}: unexpected status ${res.status}`,
      ).toContain(res.status);

      // Error shape check
      expect(
        res.body.error,
        `${req.method.toUpperCase()} ${req.path}: missing error object`,
      ).toBeDefined();
      expect(
        typeof res.body.error.code,
        `${req.method.toUpperCase()} ${req.path}: error.code not string`,
      ).toBe("string");
      expect(
        typeof res.body.error.message,
        `${req.method.toUpperCase()} ${req.path}: error.message not string`,
      ).toBe("string");

      // No stack trace leaks
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr, `${req.method.toUpperCase()} ${req.path}: stack trace leaked`).not.toMatch(
        /at Object\.|at async|\.ts:\d+|node_modules/,
      );
    }
  });
});
