/**
 * tests/play_billing.test.ts
 *
 * D1c Block 1 — Google Play Billing backend.
 * Covers V3 (state-mapping, pure, all seven SubscriptionsV2 states + unknown
 * productId) and V4 (idempotent/convergent write on redelivery).
 *
 * Live verification against real Play Console / Pub/Sub (V1, V2, V5) is done
 * manually per the standing curl protocol — not exercised here.
 */

import "dotenv/config";
import { randomUUID, randomInt } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import appPool from "../src/lib/db";
import {
  mapSubscriptionState,
  applyPlaySubscriptionWrite,
  classifyPlayApiFailure,
  PlayApiPermanentError,
  type SubscriptionsV2Response,
} from "../src/services/playBilling";

function respWith(
  state: string,
  basePlanId = "monthly-std",
  expiryTime = "2026-08-06T00:00:00Z",
): SubscriptionsV2Response {
  return {
    subscriptionState: state,
    lineItems: [{ productId: "angrez_month", expiryTime, offerDetails: { basePlanId } }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// V3 — state-mapping function, pure, no I/O
// ─────────────────────────────────────────────────────────────────────────────

describe("V3 — mapSubscriptionState covers all seven states + unknown basePlanId", () => {
  it("SUBSCRIPTION_STATE_ACTIVE → write active", () => {
    const r = mapSubscriptionState(respWith("SUBSCRIPTION_STATE_ACTIVE"));
    expect(r).toMatchObject({ write: true, status: "active", plan: "month" });
  });

  it("SUBSCRIPTION_STATE_IN_GRACE_PERIOD → write active (still entitled)", () => {
    const r = mapSubscriptionState(respWith("SUBSCRIPTION_STATE_IN_GRACE_PERIOD"));
    expect(r).toMatchObject({ write: true, status: "active", plan: "month" });
  });

  it("SUBSCRIPTION_STATE_CANCELED → write active (auto-renew off, still inside paid period)", () => {
    const r = mapSubscriptionState(respWith("SUBSCRIPTION_STATE_CANCELED", "yearly"));
    expect(r).toMatchObject({ write: true, status: "active", plan: "year" });
  });

  it("SUBSCRIPTION_STATE_CANCELED still writes the real renews_at (EXPIRED does the actual cutoff, not this)", () => {
    const r = mapSubscriptionState(respWith("SUBSCRIPTION_STATE_CANCELED", "yearly", "2026-09-15T00:00:00Z"));
    expect(r.write).toBe(true);
    if (r.write) expect(r.renewsAt.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("SUBSCRIPTION_STATE_ON_HOLD → write non-active", () => {
    const r = mapSubscriptionState(respWith("SUBSCRIPTION_STATE_ON_HOLD"));
    expect(r).toMatchObject({ write: true, status: "on_hold", plan: "month" });
  });

  it("SUBSCRIPTION_STATE_PAUSED → write non-active", () => {
    const r = mapSubscriptionState(respWith("SUBSCRIPTION_STATE_PAUSED"));
    expect(r).toMatchObject({ write: true, status: "paused", plan: "month" });
  });

  it("SUBSCRIPTION_STATE_EXPIRED → write non-active", () => {
    const r = mapSubscriptionState(respWith("SUBSCRIPTION_STATE_EXPIRED"));
    expect(r).toMatchObject({ write: true, status: "expired", plan: "month" });
  });

  it("SUBSCRIPTION_STATE_PENDING → no write (mirrors Cashfree CREATED)", () => {
    const r = mapSubscriptionState(respWith("SUBSCRIPTION_STATE_PENDING"));
    expect(r.write).toBe(false);
  });

  it("unknown basePlanId → no write, fail closed, even when state is ACTIVE", () => {
    const r = mapSubscriptionState(respWith("SUBSCRIPTION_STATE_ACTIVE", "not_a_real_base_plan"));
    expect(r.write).toBe(false);
  });

  it("the dead 'monthly' prepaid base plan → no write, fail closed (must not be confused with monthly-std)", () => {
    const r = mapSubscriptionState(respWith("SUBSCRIPTION_STATE_ACTIVE", "monthly"));
    expect(r.write).toBe(false);
    if (!r.write) expect(r.reason).toMatch(/^unknown basePlanId:/);
  });

  it("no offerDetails on the lineItem → no write, fail closed (productId alone is not enough)", () => {
    const r = mapSubscriptionState({
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      lineItems: [{ productId: "angrez_month", expiryTime: "2026-08-06T00:00:00Z" }],
    });
    expect(r.write).toBe(false);
    if (!r.write) expect(r.reason).toMatch(/^no offerDetails/);
  });

  it("unknown subscriptionState → no write, fail closed (never guesses 'inactive')", () => {
    const r = mapSubscriptionState(respWith("SUBSCRIPTION_STATE_SOME_FUTURE_VALUE"));
    expect(r.write).toBe(false);
    if (!r.write) expect(r.reason).toMatch(/^unknown subscriptionState:/);
  });

  it("no line items → no write", () => {
    const r = mapSubscriptionState({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", lineItems: [] });
    expect(r.write).toBe(false);
  });

  it("renewsAt is derived from lineItems[0].expiryTime", () => {
    const r = mapSubscriptionState(respWith("SUBSCRIPTION_STATE_ACTIVE", "monthly-std", "2027-01-01T00:00:00Z"));
    expect(r.write).toBe(true);
    if (r.write) expect(r.renewsAt.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("an intro-9 purchase (basePlanId monthly-std + offerId intro-9) maps by base plan, not offer", () => {
    const r = mapSubscriptionState({
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      lineItems: [{
        productId: "angrez_month",
        expiryTime: "2026-08-06T00:00:00Z",
        offerDetails: { basePlanId: "monthly-std", offerId: "intro-9" },
      }],
    });
    expect(r).toMatchObject({ write: true, status: "active", plan: "month" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V4 — Idempotent write: RTDN redelivery converges onto one row
// ─────────────────────────────────────────────────────────────────────────────

describe("V4 — applyPlaySubscriptionWrite is idempotent per (user_id, purchase_token)", () => {
  const USER_ID = randomUUID();
  const USER_PHONE = `+91${randomInt(6_000_000_000, 9_999_999_999)}`;
  const PURCHASE_TOKEN = `test-token-${randomUUID()}`;

  beforeAll(async () => {
    await appPool.query(
      `INSERT INTO users (id, phone, language, level) VALUES ($1, $2, 'hi', 1) ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_PHONE],
    );
  });

  afterAll(async () => {
    await appPool.query("DELETE FROM subscriptions WHERE user_id = $1", [USER_ID]);
    await appPool.query("DELETE FROM users WHERE id = $1", [USER_ID]);
    await appPool.end();
  });

  it("first write inserts one row with status active", async () => {
    await applyPlaySubscriptionWrite({
      userId: USER_ID,
      purchaseToken: PURCHASE_TOKEN,
      plan: "month",
      status: "active",
      renewsAt: new Date("2026-08-06T00:00:00Z"),
    });

    const { rows } = await appPool.query(
      "SELECT status, plan, payu_ref FROM subscriptions WHERE user_id = $1 AND payu_ref = $2",
      [USER_ID, PURCHASE_TOKEN],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("active");
  });

  it("replaying the same notification (same token, same state) is a no-op — still one row", async () => {
    await applyPlaySubscriptionWrite({
      userId: USER_ID,
      purchaseToken: PURCHASE_TOKEN,
      plan: "month",
      status: "active",
      renewsAt: new Date("2026-08-06T00:00:00Z"),
    });

    const { rows } = await appPool.query(
      "SELECT COUNT(*)::int AS cnt FROM subscriptions WHERE user_id = $1 AND payu_ref = $2",
      [USER_ID, PURCHASE_TOKEN],
    );
    expect(rows[0].cnt).toBe(1);
  });

  it("a later notification for the same token (ACTIVE → EXPIRED) converges the SAME row, not a new one", async () => {
    await applyPlaySubscriptionWrite({
      userId: USER_ID,
      purchaseToken: PURCHASE_TOKEN,
      plan: "month",
      status: "expired",
      renewsAt: new Date("2026-08-06T00:00:00Z"),
    });

    const { rows } = await appPool.query(
      "SELECT status FROM subscriptions WHERE user_id = $1 AND payu_ref = $2",
      [USER_ID, PURCHASE_TOKEN],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("expired");
  });

  it("a different purchase token for the same user writes a second, independent row", async () => {
    const otherToken = `test-token-${randomUUID()}`;
    await applyPlaySubscriptionWrite({
      userId: USER_ID,
      purchaseToken: otherToken,
      plan: "year",
      status: "active",
      renewsAt: new Date("2027-01-01T00:00:00Z"),
    });

    const { rows } = await appPool.query(
      "SELECT COUNT(*)::int AS cnt FROM subscriptions WHERE user_id = $1",
      [USER_ID],
    );
    expect(rows[0].cnt).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4xx→ack path — classifyPlayApiFailure is the pure seam fetchSubscriptionV2
// throws through. Route-level coverage would require mocking GoogleAuth's
// network calls to test one instanceof check; this is the cheap equivalent.
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyPlayApiFailure — 4xx permanent vs 5xx/network transient", () => {
  it("404 (token not found) → PlayApiPermanentError", () => {
    const err = classifyPlayApiFailure(404, "not found");
    expect(err).toBeInstanceOf(PlayApiPermanentError);
    expect((err as PlayApiPermanentError).status).toBe(404);
  });

  it("400 (malformed request) → PlayApiPermanentError", () => {
    const err = classifyPlayApiFailure(400, "bad request");
    expect(err).toBeInstanceOf(PlayApiPermanentError);
  });

  it("429 (rate limited, still 4xx) → PlayApiPermanentError", () => {
    const err = classifyPlayApiFailure(429, "rate limited");
    expect(err).toBeInstanceOf(PlayApiPermanentError);
  });

  it("500 → plain Error, not PlayApiPermanentError (transient, route should 503/redeliver)", () => {
    const err = classifyPlayApiFailure(500, "internal error");
    expect(err).not.toBeInstanceOf(PlayApiPermanentError);
    expect(err).toBeInstanceOf(Error);
  });

  it("503 → plain Error, not PlayApiPermanentError", () => {
    const err = classifyPlayApiFailure(503, "unavailable");
    expect(err).not.toBeInstanceOf(PlayApiPermanentError);
  });
});
