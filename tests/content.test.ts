/**
 * tests/content.test.ts
 *
 * Permanent automated tests for:
 *   #1 — both /content GET routes require a valid Bearer token
 *   #3 — seed upsert is idempotent (repeated insert on same key never duplicates)
 *
 * Prerequisites: DATABASE_URL, JWT_SECRET in .env; content_packs table exists.
 */

import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pool from "../src/lib/db";
import app from "../src/app";
import { signJwt } from "../src/services/jwt";

// ── Shared test user ──────────────────────────────────────────────────────────
// Direct DB insert avoids the full OTP round-trip; pool.end() is in afterAll.

const TEST_USER_ID = "c0ffee00-0004-0004-0004-c0ffee000004";
const TEST_PHONE = "+910000000404";

beforeAll(async () => {
  await pool.query(
    `INSERT INTO users (id, phone, language, level)
     VALUES ($1, $2, 'hi', 1)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, TEST_PHONE],
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM users WHERE id = $1", [TEST_USER_ID]);
  await pool.query(
    "DELETE FROM content_packs WHERE stage = 99 AND version = 99",
  );
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// #1 — Auth required: both routes must return 401 without a Bearer token
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/content/packs — auth required", () => {
  it("returns 401 with no Authorization header", async () => {
    const res = await request(app).get("/api/content/packs?language=hi");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 with a garbage token", async () => {
    const res = await request(app)
      .get("/api/content/packs?language=hi")
      .set("Authorization", "Bearer notavalidtoken");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("returns 200 with a valid token", async () => {
    const token = signJwt({ sub: TEST_USER_ID, phone: TEST_PHONE });
    const res = await request(app)
      .get("/api/content/packs?language=hi")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.packs)).toBe(true);
  });
});

describe("GET /api/content/packs/:id — auth required", () => {
  it("returns 401 with no Authorization header", async () => {
    const res = await request(app).get(
      "/api/content/packs/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 with a garbage token", async () => {
    const res = await request(app)
      .get("/api/content/packs/00000000-0000-0000-0000-000000000000")
      .set("Authorization", "Bearer bad.token.here");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("returns 404 (not 401) with a valid token and a non-existent UUID", async () => {
    const token = signJwt({ sub: TEST_USER_ID, phone: TEST_PHONE });
    const res = await request(app)
      .get("/api/content/packs/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3 — Seed idempotency: ON CONFLICT DO UPDATE never creates duplicate rows
// ─────────────────────────────────────────────────────────────────────────────

const UPSERT_SQL = `
  INSERT INTO content_packs (stage, version, language, json, published_at)
  VALUES ($1, $2, $3, $4::jsonb, now())
  ON CONFLICT (stage, version, language)
  DO UPDATE SET json = EXCLUDED.json, published_at = EXCLUDED.published_at
`;

describe("content_packs — seed idempotency", () => {
  const testPack = (name: string) =>
    JSON.stringify({
      stage: 99,
      version: 99,
      language: "hi",
      name_en: name,
      sub_stages: [{ id: "99.1" }],
    });

  it("two upserts on the same (stage, version, language) produce exactly one row", async () => {
    // First upsert — insert
    await pool.query(UPSERT_SQL, [99, 99, "hi", testPack("Pack v1")]);

    // Second upsert — should UPDATE, not insert a second row
    await pool.query(UPSERT_SQL, [99, 99, "hi", testPack("Pack v2")]);

    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM content_packs WHERE stage=99 AND version=99 AND language='hi'",
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("the second upsert replaces the json, not silently ignores it", async () => {
    const { rows } = await pool.query<{ name_en: string }>(
      "SELECT json->>'name_en' AS name_en FROM content_packs WHERE stage=99 AND version=99",
    );
    expect(rows[0].name_en).toBe("Pack v2");
  });

  it("N upserts on real packs (stage 1 and 2) still leave exactly one row each", async () => {
    // Re-run the production upsert path three more times
    for (let i = 0; i < 3; i++) {
      await pool.query(UPSERT_SQL, [
        1, 2, "hi",
        JSON.stringify({ stage: 1, version: 2, language: "hi", sub_stages: [] }),
      ]);
      await pool.query(UPSERT_SQL, [
        2, 2, "hi",
        JSON.stringify({ stage: 2, version: 2, language: "hi", sub_stages: [] }),
      ]);
    }

    const { rows } = await pool.query<{ stage: number; count: string }>(
      `SELECT stage, COUNT(*) AS count
       FROM content_packs
       WHERE (stage=1 AND version=2) OR (stage=2 AND version=2)
       GROUP BY stage
       ORDER BY stage`,
    );

    expect(rows).toHaveLength(2);
    expect(Number(rows[0].count)).toBe(1); // stage 1
    expect(Number(rows[1].count)).toBe(1); // stage 2
  });
});
