/**
 * tests/auth.test.ts
 *
 * Integration tests for auth endpoints against the live Supabase DB.
 * Each test uses unique phone numbers and cleans up after itself so the suite
 * is safe to run repeatedly.
 *
 * Prerequisites:
 *   1. `npm run migrate` applied (users, otp_codes tables exist)
 *   2. DATABASE_URL, JWT_SECRET, SMS_PROVIDER=stub in .env
 */

import "dotenv/config";
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pool from "../src/lib/db";
import app from "../src/app";
import bcrypt from "bcrypt";
import { signJwt, verifyJwt } from "../src/services/jwt";

// Unique prefixes so parallel runs don't collide
const TS = Date.now();
const PHONE = `+916${String(TS).slice(-9)}`; // valid-looking test number

async function cleanupPhone(phone: string) {
  await pool.query("DELETE FROM otp_codes WHERE phone = $1", [phone]);
  await pool.query("DELETE FROM users WHERE phone = $1", [phone]);
}

afterAll(async () => {
  await cleanupPhone(PHONE);
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// JWT unit tests (no DB, no HTTP)
// ─────────────────────────────────────────────────────────────────────────────

describe("JWT service", () => {
  it("signs a payload and verifies it back", () => {
    const token = signJwt({ sub: "test-id", phone: "+919876543210" });
    const decoded = verifyJwt(token);
    expect(decoded.sub).toBe("test-id");
    expect(decoded.phone).toBe("+919876543210");
  });

  it("rejects a token signed with the wrong secret", () => {
    const jwt = require("jsonwebtoken");
    const bad = jwt.sign({ sub: "x" }, "wrong-secret", { algorithm: "HS256" });
    expect(() => verifyJwt(bad)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OTP request — rate limiting
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/auth/otp/request — rate limiting", () => {
  const RL_PHONE = `+916${String(TS + 1).slice(-9)}`;

  afterAll(() => cleanupPhone(RL_PHONE));

  it("returns 429 after 3 requests within the window", async () => {
    // Insert 3 OTP rows directly so we don't have to fight the cooldown timer
    const hash = await bcrypt.hash("000000", 1);
    const future = new Date(Date.now() + 5 * 60 * 1000);
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO otp_codes (phone, code_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [RL_PHONE, hash, future],
      );
    }

    const res = await request(app)
      .post("/api/auth/otp/request")
      .send({ phone: RL_PHONE });

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("OTP_RATE_LIMIT");
  });

  it("rejects invalid phone with 400", async () => {
    const res = await request(app)
      .post("/api/auth/otp/request")
      .send({ phone: "12345" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PHONE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OTP verify — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/auth/otp/verify — happy path", () => {
  it("full flow: request → verify → receive JWT", async () => {
    // 1. Request OTP
    const reqRes = await request(app)
      .post("/api/auth/otp/request")
      .send({ phone: PHONE });

    expect(reqRes.status).toBe(200);
    expect(reqRes.body.ok).toBe(true);
    const { devOtp } = reqRes.body;
    expect(typeof devOtp).toBe("string"); // stub mode must return devOtp

    // 2. Verify OTP
    const verRes = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: PHONE, code: devOtp });

    expect(verRes.status).toBe(200);
    expect(typeof verRes.body.token).toBe("string");
    expect(verRes.body.user.phone).toBe(PHONE);
    expect(typeof verRes.body.isNewUser).toBe("boolean");

    // 3. Decoded token must carry the right sub
    const decoded = verifyJwt(verRes.body.token);
    expect(decoded.sub).toBe(verRes.body.user.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OTP verify — expired code
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/auth/otp/verify — expired code", () => {
  const EXP_PHONE = `+916${String(TS + 2).slice(-9)}`;

  afterAll(() => cleanupPhone(EXP_PHONE));

  it("returns 401 when OTP has already expired", async () => {
    const hash = await bcrypt.hash("123456", 1);
    // Insert an OTP that expired 1 second ago
    await pool.query(
      `INSERT INTO otp_codes (phone, code_hash, expires_at)
       VALUES ($1, $2, now() - interval '1 second')`,
      [EXP_PHONE, hash],
    );

    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: EXP_PHONE, code: "123456" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("OTP_INVALID");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OTP verify — wrong code + attempt-limit lockout
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/auth/otp/verify — attempt lockout", () => {
  const LOCK_PHONE = `+916${String(TS + 3).slice(-9)}`;

  afterAll(() => cleanupPhone(LOCK_PHONE));

  it("locks after max failed attempts", async () => {
    // Insert a valid, unexpired OTP
    const realCode = "999999";
    const hash = await bcrypt.hash(realCode, 1);
    await pool.query(
      `INSERT INTO otp_codes (phone, code_hash, expires_at)
       VALUES ($1, $2, now() + interval '5 minutes')`,
      [LOCK_PHONE, hash],
    );

    // Exhaust all attempts with the wrong code
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post("/api/auth/otp/verify")
        .send({ phone: LOCK_PHONE, code: "000000" });
      expect(r.status).toBe(401);
    }

    // Now the correct code should also be rejected (locked)
    const finalRes = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: LOCK_PHONE, code: realCode });

    expect(finalRes.status).toBe(401);
    expect(finalRes.body.error.code).toBe("OTP_LOCKED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /auth/me — valid and invalid token
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/auth/me", () => {
  it("returns the user when a valid token is provided", async () => {
    // Request + verify to get a real token
    const reqRes = await request(app)
      .post("/api/auth/otp/request")
      .send({ phone: PHONE });
    // PHONE may already have a consumed OTP from the happy-path test; if so
    // we need a fresh OTP. Re-use devOtp if present, else this is a second call.
    const devOtp = reqRes.body.devOtp;
    if (!devOtp) {
      // Phone already has a user — fetch it directly with a fresh OTP
      // Insert a new OTP after the cooldown trick
      const hash = await bcrypt.hash("777777", 1);
      await pool.query(
        `INSERT INTO otp_codes (phone, code_hash, expires_at)
         VALUES ($1, $2, now() + interval '5 minutes')`,
        [PHONE, hash],
      );
      const verRes2 = await request(app)
        .post("/api/auth/otp/verify")
        .send({ phone: PHONE, code: "777777" });
      expect(verRes2.status).toBe(200);

      const meRes = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${verRes2.body.token}`);
      expect(meRes.status).toBe(200);
      expect(meRes.body.user.phone).toBe(PHONE);
      return;
    }

    const verRes = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: PHONE, code: devOtp });

    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${verRes.body.token}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.user.phone).toBe(PHONE);
  });

  it("returns 401 with no token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 with a garbage token", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer notavalidtoken");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });
});
