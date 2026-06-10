/**
 * tests/wallet.test.ts
 *
 * GET /api/wallet — Part A of Step 6.
 *
 * Covers:
 *   - balance == SUM(ledger) for a user with entries
 *   - empty wallet → balance 0 and transactions []
 *   - pagination (limit / offset)
 *   - 401 without auth
 *   - static: route performs no writes
 */

import "dotenv/config";
import { randomUUID, randomInt } from "crypto";
import { readFileSync } from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pool from "../src/lib/db";
import app from "../src/app";
import { signJwt } from "../src/services/jwt";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ID = randomUUID();
const USER_PHONE = `+91${randomInt(6_000_000_000, 9_999_999_999)}`;

const EMPTY_USER_ID = randomUUID();
const EMPTY_USER_PHONE = `+91${randomInt(6_000_000_000, 9_999_999_999)}`;

let token: string;
let emptyToken: string;

// Three ledger entries for the main user (for pagination tests)
const KEYS = [randomUUID(), randomUUID(), randomUUID()];
const AMOUNTS = [50, 30, 20]; // total = 100

beforeAll(async () => {
  await pool.query(
    `INSERT INTO users (id, phone, language, level) VALUES ($1, $2, 'hi', 1) ON CONFLICT (id) DO NOTHING`,
    [USER_ID, USER_PHONE],
  );
  await pool.query(
    `INSERT INTO users (id, phone, language, level) VALUES ($1, $2, 'hi', 1) ON CONFLICT (id) DO NOTHING`,
    [EMPTY_USER_ID, EMPTY_USER_PHONE],
  );

  // Seed three ledger rows in order (small sleep avoids same-millisecond created_at)
  for (let i = 0; i < KEYS.length; i++) {
    await pool.query(
      `INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key)
       VALUES ($1, $2, 'test_wallet', $3)`,
      [USER_ID, AMOUNTS[i], KEYS[i]],
    );
  }

  token = signJwt({ sub: USER_ID, phone: USER_PHONE });
  emptyToken = signJwt({ sub: EMPTY_USER_ID, phone: EMPTY_USER_PHONE });
});

afterAll(async () => {
  await pool.query("DELETE FROM puzzle_results WHERE user_id IN ($1, $2)", [USER_ID, EMPTY_USER_ID]);
  await pool.query("DELETE FROM progress WHERE user_id IN ($1, $2)", [USER_ID, EMPTY_USER_ID]);
  // wallet_ledger is append-only (trigger prevents DELETE); rows left intentionally.
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// Core behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/wallet — balance + statement", () => {
  it("balance equals SUM(delta_points) from wallet_ledger", async () => {
    const expected = AMOUNTS.reduce((a, b) => a + b, 0); // 100

    const res = await request(app)
      .get("/api/wallet")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(expected);

    // Matches raw SUM (MP-10 invariant: view == ledger SUM)
    const { rows } = await pool.query<{ bal: number }>(
      "SELECT COALESCE(SUM(delta_points), 0)::int AS bal FROM wallet_ledger WHERE user_id = $1",
      [USER_ID],
    );
    expect(res.body.balance).toBe(rows[0].bal);
  });

  it("empty wallet returns balance 0 and transactions []", async () => {
    const res = await request(app)
      .get("/api/wallet")
      .set("Authorization", `Bearer ${emptyToken}`);

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(0);
    expect(res.body.transactions).toEqual([]);
  });

  it("transactions are newest-first", async () => {
    const res = await request(app)
      .get("/api/wallet")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const dates = res.body.transactions.map((t: { created_at: string }) => t.created_at);
    const sorted = [...dates].sort((a, b) => b.localeCompare(a));
    expect(dates).toEqual(sorted);
  });

  it("pagination: limit=1 returns one transaction", async () => {
    const res = await request(app)
      .get("/api/wallet?limit=1&offset=0")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(0);
  });

  it("pagination: offset steps through pages without repeats", async () => {
    const p1 = await request(app)
      .get("/api/wallet?limit=1&offset=0")
      .set("Authorization", `Bearer ${token}`);
    const p2 = await request(app)
      .get("/api/wallet?limit=1&offset=1")
      .set("Authorization", `Bearer ${token}`);
    const p3 = await request(app)
      .get("/api/wallet?limit=1&offset=2")
      .set("Authorization", `Bearer ${token}`);

    const ids = [
      p1.body.transactions[0].id,
      p2.body.transactions[0].id,
      p3.body.transactions[0].id,
    ];
    // All distinct — no row served twice
    expect(new Set(ids).size).toBe(3);
  });

  it("limit is capped at 50", async () => {
    const res = await request(app)
      .get("/api/wallet?limit=999")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(50);
  });

  it("returns 401 without an Authorization header", async () => {
    const res = await request(app).get("/api/wallet");
    expect(res.status).toBe(401);
  });

  it("static: wallet route contains no INSERT, UPDATE, or DELETE", () => {
    const src = readFileSync("/Users/Pratap1/angrez/src/routes/wallet.ts", "utf-8");
    expect(src).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
  });
});
