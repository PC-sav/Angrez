/**
 * tests/campaigns.test.ts
 *
 * Step 9A — Campaign claim mechanism.
 * Tests: idempotency, quota enforcement, inactive/expired guards, admin auth.
 *
 * Uses randomUUID campaign IDs to avoid collisions with real data.
 * wallet_ledger rows are left in place (append-only trigger).
 */

import "dotenv/config";
import { randomUUID, randomInt } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pool from "../src/lib/db";
import app from "../src/app";
import { signJwt } from "../src/services/jwt";

// ── Admin key ─────────────────────────────────────────────────────────────────
// Set before app import resolves any cached env — admin auth middleware reads
// process.env.ADMIN_API_KEY at request time, so setting it here is sufficient.

const ADMIN_KEY = "test-admin-key-campaigns-9a";
process.env.ADMIN_API_KEY = ADMIN_KEY;

// ── Helpers ───────────────────────────────────────────────────────────────────

function phone(): string {
  return `+91${randomInt(6_000_000_000, 9_999_999_999)}`;
}

function futureDate(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function campId(): string {
  return `test-camp-${randomUUID()}`;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_A_ID = randomUUID();
const USER_B_ID = randomUUID();
const USER_C_ID = randomUUID();

let tokenA: string;
let tokenB: string;
let tokenC: string;

// Campaigns created during tests — tracked for cleanup
const createdCampIds: string[] = [];

beforeAll(async () => {
  // Create 3 test users
  for (const [id, ph] of [
    [USER_A_ID, phone()],
    [USER_B_ID, phone()],
    [USER_C_ID, phone()],
  ]) {
    await pool.query(
      `INSERT INTO users (id, phone, language, level) VALUES ($1, $2, 'hi', 1)
       ON CONFLICT (id) DO NOTHING`,
      [id, ph],
    );
  }

  tokenA = signJwt({ sub: USER_A_ID, phone: "" });
  tokenB = signJwt({ sub: USER_B_ID, phone: "" });
  tokenC = signJwt({ sub: USER_C_ID, phone: "" });
});

afterAll(async () => {
  if (createdCampIds.length > 0) {
    await pool.query(
      "DELETE FROM campaign_grants WHERE campaign_id = ANY($1::text[])",
      [createdCampIds],
    );
    await pool.query(
      "DELETE FROM campaigns WHERE id = ANY($1::text[])",
      [createdCampIds],
    );
  }
  // wallet_ledger rows intentionally left (append-only trigger)
});

// ── Helper: create a campaign via admin endpoint ──────────────────────────────

async function createCamp(overrides: Record<string, unknown> = {}) {
  const id = campId();
  const body = {
    id,
    name: "Test Campaign",
    type: "bonus_points",
    starts_at: futureDate(-60_000),   // started 1 min ago
    ends_at:   futureDate(3_600_000), // ends in 1 hour
    award_points: 50,
    ...overrides,
  };
  const res = await request(app)
    .post("/admin/campaigns")
    .set("x-admin-key", ADMIN_KEY)
    .send(body);
  expect(res.status).toBe(201);
  createdCampIds.push(id);
  return res.body as { id: string; granted_count: number; [k: string]: unknown };
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin auth
// ─────────────────────────────────────────────────────────────────────────────

describe("Admin auth", () => {
  it("GET /admin/campaigns → 401 with no x-admin-key", async () => {
    const res = await request(app).get("/admin/campaigns");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("GET /admin/campaigns → 401 with wrong x-admin-key", async () => {
    const res = await request(app)
      .get("/admin/campaigns")
      .set("x-admin-key", "wrong-key");
    expect(res.status).toBe(401);
  });

  it("POST /admin/campaigns → 401 with no key", async () => {
    const res = await request(app).post("/admin/campaigns").send({});
    expect(res.status).toBe(401);
  });

  it("PATCH /admin/campaigns/:id → 401 with no key", async () => {
    const res = await request(app).patch("/admin/campaigns/any-id").send({});
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe("Admin campaign CRUD", () => {
  it("POST /admin/campaigns → 201 with valid body", async () => {
    const camp = await createCamp({ name: "CRUD test camp", award_points: 10 });
    expect(camp.id).toBeTruthy();
    expect(camp.granted_count).toBe(0);
  });

  it("POST /admin/campaigns → 400 for missing required fields", async () => {
    const res = await request(app)
      .post("/admin/campaigns")
      .set("x-admin-key", ADMIN_KEY)
      .send({ id: "x", name: "No type" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_FIELDS");
  });

  it("POST /admin/campaigns → 400 for invalid type", async () => {
    const res = await request(app)
      .post("/admin/campaigns")
      .set("x-admin-key", ADMIN_KEY)
      .send({
        id: campId(),
        name: "Bad type",
        type: "not_a_real_type",
        starts_at: futureDate(-1000),
        ends_at: futureDate(3_600_000),
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_TYPE");
  });

  it("PATCH /admin/campaigns/:id → updates active and ends_at", async () => {
    const camp = await createCamp({ name: "Patch target" });
    const newEnd = futureDate(7_200_000);

    const res = await request(app)
      .patch(`/admin/campaigns/${camp.id}`)
      .set("x-admin-key", ADMIN_KEY)
      .send({ active: true, ends_at: newEnd });

    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
    expect(new Date(res.body.ends_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("PATCH /admin/campaigns/:id → 400 if body contains id", async () => {
    const camp = await createCamp();
    const res = await request(app)
      .patch(`/admin/campaigns/${camp.id}`)
      .set("x-admin-key", ADMIN_KEY)
      .send({ id: "new-id" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IMMUTABLE_FIELDS");
  });

  it("PATCH /admin/campaigns/:id → 400 if body contains type", async () => {
    const camp = await createCamp();
    const res = await request(app)
      .patch(`/admin/campaigns/${camp.id}`)
      .set("x-admin-key", ADMIN_KEY)
      .send({ type: "early_bird" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IMMUTABLE_FIELDS");
  });

  it("PATCH /admin/campaigns/:id → 404 for unknown id", async () => {
    const res = await request(app)
      .patch("/admin/campaigns/does-not-exist")
      .set("x-admin-key", ADMIN_KEY)
      .send({ active: true });
    expect(res.status).toBe(404);
  });

  it("GET /admin/campaigns → lists all with remaining field", async () => {
    const camp = await createCamp({ quota: 5 });
    const res = await request(app)
      .get("/admin/campaigns")
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((c: { id: string }) => c.id === camp.id);
    expect(found).toBeTruthy();
    expect(found.remaining).toBe(5); // quota=5, granted_count=0
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/campaigns/active
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/campaigns/active", () => {
  it("returns only active, in-window campaigns", async () => {
    const activeCamp = await createCamp({ name: "Active", award_points: 5 });

    // Activate it
    await request(app)
      .patch(`/admin/campaigns/${activeCamp.id}`)
      .set("x-admin-key", ADMIN_KEY)
      .send({ active: true });

    const res = await request(app)
      .get("/api/campaigns/active")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((c: { id: string }) => c.id === activeCamp.id);
    expect(found).toBeTruthy();
    expect(found.award_points).toBe(5);
  });

  it("does not return inactive campaigns", async () => {
    const inactiveCamp = await createCamp({ name: "Inactive stays hidden" });
    // Not activated — active defaults to false

    const res = await request(app)
      .get("/api/campaigns/active")
      .set("Authorization", `Bearer ${tokenA}`);

    const found = res.body.find((c: { id: string }) => c.id === inactiveCamp.id);
    expect(found).toBeUndefined();
  });

  it("requires auth → 401 without token", async () => {
    const res = await request(app).get("/api/campaigns/active");
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/campaigns/:id/claim — inactive / expired guard
// ─────────────────────────────────────────────────────────────────────────────

describe("Claim — inactive / expired campaign", () => {
  it("returns 409 for inactive campaign (active=false)", async () => {
    const camp = await createCamp({ name: "Inactive claim test" });
    // Not activated

    const res = await request(app)
      .post(`/api/campaigns/${camp.id}/claim`)
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CAMPAIGN_UNAVAILABLE");
  });

  it("returns 409 for expired campaign", async () => {
    // Create via direct DB insert — admin endpoint enforces ends_at > now can be past for expiry sim
    const id = campId();
    createdCampIds.push(id);
    await pool.query(
      `INSERT INTO campaigns (id, name, type, active, starts_at, ends_at, award_points)
       VALUES ($1, 'Expired', 'bonus_points', true,
               now() - interval '2 hours', now() - interval '1 hour', 0)`,
      [id],
    );

    const res = await request(app)
      .post(`/api/campaigns/${id}/claim`)
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CAMPAIGN_UNAVAILABLE");
  });

  it("returns 404 for unknown campaign id", async () => {
    const res = await request(app)
      .post("/api/campaigns/does-not-exist-xyz/claim")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/campaigns/:id/claim — idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("Claim — idempotency", () => {
  it("same user claiming twice: 2nd returns already_claimed=true, only 1 grant row, only 1 ledger row", async () => {
    const camp = await createCamp({ name: "Idempotency test", award_points: 25 });
    await request(app)
      .patch(`/admin/campaigns/${camp.id}`)
      .set("x-admin-key", ADMIN_KEY)
      .send({ active: true });

    const res1 = await request(app)
      .post(`/api/campaigns/${camp.id}/claim`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res1.status).toBe(200);
    expect(res1.body.already_claimed).toBe(false);
    expect(res1.body.award_points).toBe(25);

    const res2 = await request(app)
      .post(`/api/campaigns/${camp.id}/claim`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res2.status).toBe(200);
    expect(res2.body.already_claimed).toBe(true);
    expect(res2.body.award_points).toBe(25);

    // Exactly one grant row
    const { rows: grants } = await pool.query(
      "SELECT COUNT(*)::int AS cnt FROM campaign_grants WHERE campaign_id = $1 AND user_id = $2",
      [camp.id, USER_A_ID],
    );
    expect(grants[0].cnt).toBe(1);

    // Exactly one ledger row
    const { rows: ledger } = await pool.query(
      "SELECT COUNT(*)::int AS cnt FROM wallet_ledger WHERE idempotency_key = $1",
      [`promo:${camp.id}:${USER_A_ID}`],
    );
    expect(ledger[0].cnt).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/campaigns/:id/claim — quota enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe("Claim — quota enforcement", () => {
  it("quota=2: first 2 users succeed, 3rd gets 409; granted_count stays at 2", async () => {
    const camp = await createCamp({ name: "Quota=2 test", quota: 2, award_points: 10 });
    await request(app)
      .patch(`/admin/campaigns/${camp.id}`)
      .set("x-admin-key", ADMIN_KEY)
      .send({ active: true });

    const resA = await request(app)
      .post(`/api/campaigns/${camp.id}/claim`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(resA.status).toBe(200);
    expect(resA.body.already_claimed).toBe(false);

    const resB = await request(app)
      .post(`/api/campaigns/${camp.id}/claim`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(resB.status).toBe(200);
    expect(resB.body.already_claimed).toBe(false);

    const resC = await request(app)
      .post(`/api/campaigns/${camp.id}/claim`)
      .set("Authorization", `Bearer ${tokenC}`);
    expect(resC.status).toBe(409);
    expect(resC.body.error.code).toBe("QUOTA_EXHAUSTED");

    // granted_count must still be 2 (not 3)
    const { rows } = await pool.query<{ granted_count: number }>(
      "SELECT granted_count FROM campaigns WHERE id = $1",
      [camp.id],
    );
    expect(rows[0].granted_count).toBe(2);
  });

  it("unlimited quota (quota=null): all 3 users claim successfully", async () => {
    const camp = await createCamp({ name: "Unlimited quota", quota: null, award_points: 5 });
    await request(app)
      .patch(`/admin/campaigns/${camp.id}`)
      .set("x-admin-key", ADMIN_KEY)
      .send({ active: true });

    for (const token of [tokenA, tokenB, tokenC]) {
      const res = await request(app)
        .post(`/api/campaigns/${camp.id}/claim`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    }

    const { rows } = await pool.query<{ granted_count: number }>(
      "SELECT granted_count FROM campaigns WHERE id = $1",
      [camp.id],
    );
    expect(rows[0].granted_count).toBe(3);
  });
});
