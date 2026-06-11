/**
 * tests/pool_timeout.test.ts
 *
 * Verifies pool config, the fast-rejection behaviour on exhaustion, and that
 * the route layer maps connection-timeout errors to 503 SERVICE_UNAVAILABLE.
 *
 * Two pool strategies:
 *   testPool  — isolated pool (max:2, timeout:400ms) for fast unit-level checks.
 *   appPool   — the shared app pool used to verify the HTTP 503 mapping.
 *               Its connectionTimeoutMillis is temporarily lowered to 400ms for
 *               the HTTP test so we don't wait the full 5 s.
 */

import "dotenv/config";
import { randomUUID, randomInt } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import request from "supertest";
import appPool from "../src/lib/db";
import app from "../src/app";
import { signJwt } from "../src/services/jwt";
import { isConnectionError } from "../src/lib/errors";

// ── Isolated pool ─────────────────────────────────────────────────────────────

const TIMEOUT_MS = 400;

// testPool uses a normal connection timeout for establishment, so parallel
// workers don't race on the initial TCP handshake. TIMEOUT_MS is applied
// inside each test only for the queue-wait phase (after all slots are taken).
const testPool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  max: 2,
  connectionTimeoutMillis: 5000,
  ssl: process.env.DATABASE_URL!.includes("supabase.co")
    ? { rejectUnauthorized: false }
    : undefined,
});

// ── Auth fixture for HTTP tests ───────────────────────────────────────────────

const TEST_USER_ID = randomUUID();
const TEST_PHONE = `+91${randomInt(6_000_000_000, 9_999_999_999)}`;
let token: string;

beforeAll(async () => {
  await appPool.query(
    `INSERT INTO users (id, phone, language, level)
     VALUES ($1, $2, 'hi', 1)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, TEST_PHONE],
  );
  token = signJwt({ sub: TEST_USER_ID, phone: TEST_PHONE });
});

afterAll(async () => {
  await testPool.end();
  // Note: appPool is shared; pool_timeout.test.ts does not call appPool.end()
  // (other workers use their own instances; this worker's instance is GC'd).
});

// ── Helpers ───────────────────────────────────────────────────────────────────

type PoolWithOptions = { options: { connectionTimeoutMillis: number } };

/** Temporarily lower the app pool's connectionTimeoutMillis for one test. */
async function withReducedTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const opts = (appPool as unknown as PoolWithOptions).options;
  const orig = opts.connectionTimeoutMillis;
  opts.connectionTimeoutMillis = ms;
  try {
    return await fn();
  } finally {
    opts.connectionTimeoutMillis = orig;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool configuration
// ─────────────────────────────────────────────────────────────────────────────

describe("Pool configuration", () => {
  it("app pool has connectionTimeoutMillis set to 5000", () => {
    const opts = (appPool as unknown as PoolWithOptions).options;
    expect(opts.connectionTimeoutMillis).toBe(5000);
    expect((appPool as unknown as { options: { max: number } }).options.max).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isConnectionError classifier
// ─────────────────────────────────────────────────────────────────────────────

describe("isConnectionError classifier", () => {
  it("classifies pool-exhaustion timeout as a connection error", () => {
    expect(isConnectionError(new Error("timeout exceeded when trying to connect"))).toBe(true);
  });

  it("classifies ECONNREFUSED as a connection error", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isConnectionError(err)).toBe(true);
  });

  it("classifies ECONNRESET as a connection error", () => {
    const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(isConnectionError(err)).toBe(true);
  });

  it("classifies Postgres 57P03 (cannot_connect_now) as a connection error", () => {
    expect(isConnectionError({ code: "57P03" })).toBe(true);
  });

  it("does NOT classify a unique-violation (23505) as a connection error", () => {
    expect(isConnectionError({ code: "23505" })).toBe(false);
  });

  it("does NOT classify a generic logic Error as a connection error", () => {
    expect(isConnectionError(new Error("something went wrong in my code"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pool exhaustion — fast rejection
// ─────────────────────────────────────────────────────────────────────────────

describe("Pool exhaustion → fast rejection, not a hang", () => {
  it("rejects within 2× the timeout with 'timeout exceeded' error", async () => {
    const opts = (testPool as unknown as PoolWithOptions).options;
    const held: Array<{ release: () => void }> = [];

    // Acquire both slots at normal timeout (avoids TCP-handshake races with parallel workers).
    for (let i = 0; i < 2; i++) {
      held.push(await testPool.connect());
    }

    // Now reduce: the 3rd request must queue and time out quickly.
    opts.connectionTimeoutMillis = TIMEOUT_MS;

    const start = Date.now();
    let caughtErr: Error | null = null;

    try {
      await testPool.query("SELECT 1");
    } catch (err) {
      caughtErr = err as Error;
    } finally {
      opts.connectionTimeoutMillis = 5000;
      held.forEach((c) => c.release());
    }

    expect(caughtErr).not.toBeNull();
    expect(caughtErr!.message).toMatch(/timeout exceeded/i);
    expect(Date.now() - start).toBeLessThan(TIMEOUT_MS * 2);
    // Confirms the classifier will catch this exact error
    expect(isConnectionError(caughtErr!)).toBe(true);
  });

  it("pool recovers after connections are released", async () => {
    const held: Array<{ release: () => void }> = [];
    for (let i = 0; i < 2; i++) held.push(await testPool.connect());
    held.forEach((c) => c.release());

    const { rows } = await testPool.query<{ n: number }>("SELECT 1 AS n");
    expect(rows[0].n).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP layer: pool exhaustion → 503 SERVICE_UNAVAILABLE + Retry-After
// ─────────────────────────────────────────────────────────────────────────────

describe("HTTP layer: pool exhaustion → 503", () => {
  it("returns 503 SERVICE_UNAVAILABLE with Retry-After header, not 500 or a hang", async () => {
    const opts = (appPool as unknown as PoolWithOptions).options;
    const origTimeout = opts.connectionTimeoutMillis;

    // Acquire all 5 slots at normal timeout (avoids TCP-handshake races with parallel workers).
    const held: Array<{ release: () => void }> = [];
    for (let i = 0; i < 5; i++) {
      held.push(await appPool.connect());
    }

    // Now reduce so the app's next connect attempt fails quickly.
    opts.connectionTimeoutMillis = TIMEOUT_MS;

    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(app)
        .get("/api/plan/next")
        .set("Authorization", `Bearer ${token}`);
    } finally {
      opts.connectionTimeoutMillis = origTimeout;
      held.forEach((c) => c.release());
    }

    expect(res!.status).toBe(503);
    expect(res!.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(typeof res!.body.error.message).toBe("string");
    expect(res!.headers["retry-after"]).toBe("5");
  }, 8000); // generous timeout: 5× TIMEOUT_MS + HTTP overhead
});
