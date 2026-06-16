/**
 * tests/referrals.test.ts
 *
 * Part B — Referral relationship capture at signup.
 * Part C — creditReferral (built, NOT yet called from payment flow).
 *
 * Existing DB schema (pre-migration): referrals table uses column names
 * `referred_id` (referee) and `bonus_state` (status).
 */

import "dotenv/config";
import { randomUUID, randomInt } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pool from "../src/lib/db";
import app from "../src/app";
import {
  resolveReferralCode,
  captureReferral,
  creditReferral,
  REFERRAL_REWARD_POINTS,
} from "../src/services/referrals";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Same formula as the GENERATED ALWAYS AS column in the DB.
function codeFor(userId: string): string {
  return userId.replace(/-/g, "").slice(0, 12).toUpperCase();
}

function phone(): string {
  return `+91${randomInt(6_000_000_000, 9_999_999_999)}`;
}

// ── Main test fixtures ────────────────────────────────────────────────────────

// REFERRER and REFEREE are created once, reused across Part B and Part C.
const REFERRER_ID = randomUUID();
const REFEREE_ID = randomUUID();
const REFERRER_PHONE = phone();
const REFEREE_PHONE = phone();

// Separate users for Part C to avoid state from Part B.
const CR_REFERRER = randomUUID();
const CR_REFEREE = randomUUID();

beforeAll(async () => {
  await pool.query(
    `INSERT INTO users (id, phone, language, level) VALUES ($1, $2, 'hi', 1) ON CONFLICT (id) DO NOTHING`,
    [REFERRER_ID, REFERRER_PHONE],
  );
  await pool.query(
    `INSERT INTO users (id, phone, language, level) VALUES ($1, $2, 'hi', 1) ON CONFLICT (id) DO NOTHING`,
    [REFEREE_ID, REFEREE_PHONE],
  );
  await pool.query(
    `INSERT INTO users (id, phone, language, level) VALUES ($1, $2, 'hi', 1) ON CONFLICT (id) DO NOTHING`,
    [CR_REFERRER, phone()],
  );
  await pool.query(
    `INSERT INTO users (id, phone, language, level) VALUES ($1, $2, 'hi', 1) ON CONFLICT (id) DO NOTHING`,
    [CR_REFEREE, phone()],
  );

  // Seed a pending referral for Part C (creditReferral needs an existing row to flip).
  await pool.query(
    `INSERT INTO referrals (referrer_id, referred_id, code, bonus_state)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (referred_id) DO NOTHING`,
    [CR_REFERRER, CR_REFEREE, codeFor(CR_REFERRER)],
  );
});

afterAll(async () => {
  // referrals is not append-only — safe to delete.
  await pool.query(
    `DELETE FROM referrals WHERE referrer_id = ANY($1::uuid[]) OR referred_id = ANY($1::uuid[])`,
    [[REFERRER_ID, REFEREE_ID, CR_REFERRER, CR_REFEREE]],
  );
  // wallet_ledger rows are intentionally left (append-only trigger + ON DELETE RESTRICT).
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// Part B — resolveReferralCode + captureReferral (service-level)
// ─────────────────────────────────────────────────────────────────────────────

describe("Part B — referral relationship capture", () => {
  it("resolveReferralCode returns the referrer's user id for a valid code", async () => {
    const code = codeFor(REFERRER_ID);
    const resolved = await resolveReferralCode(code);
    expect(resolved).toBe(REFERRER_ID);
  });

  it("resolveReferralCode returns null for an unknown code", async () => {
    const resolved = await resolveReferralCode("ZZZZZZZZZZZZ");
    expect(resolved).toBeNull();
  });

  it("valid code → captureReferral stores a pending row", async () => {
    await captureReferral(REFERRER_ID, REFEREE_ID, codeFor(REFERRER_ID));

    const { rows } = await pool.query(
      "SELECT referrer_id, bonus_state FROM referrals WHERE referred_id = $1",
      [REFEREE_ID],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].referrer_id).toBe(REFERRER_ID);
    expect(rows[0].bonus_state).toBe("pending");
  });

  it("invalid code → resolveReferralCode is null → no referral row created", async () => {
    const ANON_ID = randomUUID();
    await pool.query(
      `INSERT INTO users (id, phone, language, level) VALUES ($1, $2, 'hi', 1) ON CONFLICT (id) DO NOTHING`,
      [ANON_ID, phone()],
    );

    const referrerId = await resolveReferralCode("BADCODE00000");
    expect(referrerId).toBeNull();

    const { rows } = await pool.query(
      "SELECT 1 FROM referrals WHERE referred_id = $1",
      [ANON_ID],
    );
    expect(rows.length).toBe(0);
  });

  it("self-referral → captureReferral is a no-op, no row created", async () => {
    const SELF_ID = randomUUID();
    await pool.query(
      `INSERT INTO users (id, phone, language, level) VALUES ($1, $2, 'hi', 1) ON CONFLICT (id) DO NOTHING`,
      [SELF_ID, phone()],
    );

    await captureReferral(SELF_ID, SELF_ID, codeFor(SELF_ID));

    const { rows } = await pool.query(
      "SELECT 1 FROM referrals WHERE referred_id = $1",
      [SELF_ID],
    );
    expect(rows.length).toBe(0);
  });

  it("second referral for the same referee → silently rejected, first referrer retained", async () => {
    // REFEREE_ID already has a pending row pointing to REFERRER_ID (from the test above).
    const THIRD_ID = randomUUID();
    await pool.query(
      `INSERT INTO users (id, phone, language, level) VALUES ($1, $2, 'hi', 1) ON CONFLICT (id) DO NOTHING`,
      [THIRD_ID, phone()],
    );

    await captureReferral(THIRD_ID, REFEREE_ID, codeFor(THIRD_ID));

    const { rows } = await pool.query(
      "SELECT referrer_id FROM referrals WHERE referred_id = $1",
      [REFEREE_ID],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].referrer_id).toBe(REFERRER_ID); // original referrer unchanged
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part B — HTTP integration: referral_code wired into POST /auth/otp/verify
// ─────────────────────────────────────────────────────────────────────────────

describe("Part B — HTTP: referral_code in POST /auth/otp/verify", () => {
  const HTTP_REFERRER_PHONE = phone();
  const HTTP_REFEREE_PHONE = phone();
  let httpReferrerId: string;

  beforeAll(async () => {
    // Create the referrer via OTP flow to get a proper DB row with referral_code.
    const otpReq = await request(app)
      .post("/api/auth/otp/request")
      .send({ phone: HTTP_REFERRER_PHONE });
    const verRes = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: HTTP_REFERRER_PHONE, code: otpReq.body.devOtp });
    httpReferrerId = verRes.body.user.id;
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM referrals WHERE referrer_id = $1 OR referred_id IN (SELECT id FROM users WHERE phone = $2)`,
      [httpReferrerId, HTTP_REFEREE_PHONE],
    );
    await pool.query("DELETE FROM otp_codes WHERE phone IN ($1, $2)", [HTTP_REFERRER_PHONE, HTTP_REFEREE_PHONE]);
    await pool.query(
      "DELETE FROM first_n_signups WHERE user_id IN (SELECT id FROM users WHERE phone IN ($1, $2))",
      [HTTP_REFERRER_PHONE, HTTP_REFEREE_PHONE],
    );
    try {
      await pool.query("DELETE FROM users WHERE phone IN ($1, $2)", [HTTP_REFERRER_PHONE, HTTP_REFEREE_PHONE]);
    } catch {
      // wallet_ledger FK — test artifact users remain in DB if a campaign claim was made
    }
  });

  it("valid referral_code in OTP verify creates a pending referral row", async () => {
    const referrerCode = codeFor(httpReferrerId);

    const otpReq = await request(app)
      .post("/api/auth/otp/request")
      .send({ phone: HTTP_REFEREE_PHONE });

    const verRes = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: HTTP_REFEREE_PHONE, code: otpReq.body.devOtp, referral_code: referrerCode });

    expect(verRes.status).toBe(200);
    expect(verRes.body.isNewUser).toBe(true);

    const refereeId: string = verRes.body.user.id;
    const { rows } = await pool.query(
      "SELECT referrer_id, bonus_state FROM referrals WHERE referred_id = $1",
      [refereeId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].referrer_id).toBe(httpReferrerId);
    expect(rows[0].bonus_state).toBe("pending");
  });

  it("invalid referral_code in OTP verify → signup succeeds, no referral row", async () => {
    const EXTRA_PHONE = phone();
    const otpReq = await request(app)
      .post("/api/auth/otp/request")
      .send({ phone: EXTRA_PHONE });

    const verRes = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: EXTRA_PHONE, code: otpReq.body.devOtp, referral_code: "ZZZZZZZZZZZZ" });

    expect(verRes.status).toBe(200);
    expect(typeof verRes.body.token).toBe("string");

    const refereeId: string = verRes.body.user.id;
    const { rows } = await pool.query(
      "SELECT 1 FROM referrals WHERE referred_id = $1",
      [refereeId],
    );
    expect(rows.length).toBe(0);

    // Cleanup
    await pool.query("DELETE FROM otp_codes WHERE phone = $1", [EXTRA_PHONE]);
    await pool.query(
      "DELETE FROM first_n_signups WHERE user_id = (SELECT id FROM users WHERE phone = $1)",
      [EXTRA_PHONE],
    );
    try {
      await pool.query("DELETE FROM users WHERE phone = $1", [EXTRA_PHONE]);
    } catch {
      // wallet_ledger FK — test artifact user remains in DB if a campaign claim was made
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part C — creditReferral (built, NOT yet called from payment flow)
// ─────────────────────────────────────────────────────────────────────────────

describe("Part C — creditReferral (one call site, added later after PayU verified)", () => {
  it("one call → exactly one ledger row, referrer credited REFERRAL_REWARD_POINTS", async () => {
    await creditReferral(CR_REFERRER, CR_REFEREE);

    const { rows } = await pool.query<{ cnt: number; total: number }>(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(delta_points), 0)::int AS total
       FROM wallet_ledger WHERE idempotency_key = $1`,
      [`referral:${CR_REFERRER}:${CR_REFEREE}`],
    );
    expect(rows[0].cnt).toBe(1);
    expect(rows[0].total).toBe(REFERRAL_REWARD_POINTS);

    // Status flipped to 'credited'
    const { rows: ref } = await pool.query(
      "SELECT bonus_state FROM referrals WHERE referrer_id = $1 AND referred_id = $2",
      [CR_REFERRER, CR_REFEREE],
    );
    expect(ref[0].bonus_state).toBe("converted");
  });

  it("two calls, same (referrer, referee) → still exactly one ledger row", async () => {
    await creditReferral(CR_REFERRER, CR_REFEREE); // idempotent second call

    const { rows } = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM wallet_ledger WHERE idempotency_key = $1",
      [`referral:${CR_REFERRER}:${CR_REFEREE}`],
    );
    expect(rows[0].cnt).toBe(1);
  });

  it("self-referral → creditReferral is a no-op, no ledger row created", async () => {
    await creditReferral(CR_REFERRER, CR_REFERRER);

    const { rows } = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM wallet_ledger WHERE idempotency_key = $1",
      [`referral:${CR_REFERRER}:${CR_REFERRER}`],
    );
    expect(rows[0].cnt).toBe(0);
  });
});
