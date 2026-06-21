import crypto from "crypto";
import pool from "../lib/db";
import { env } from "../config/env";

// ── Plan catalogue ────────────────────────────────────────────────────────────
// 9C will extend getPriceForPlan to check campaign overrides; everything reads
// price through this single function — no amount literals anywhere else.

export type Plan = "trial" | "month" | "year";

const PLAN_CONFIG: Record<Plan, { amount: number; durationDays: number }> = {
  trial: { amount: 9,   durationDays: 7   },
  month: { amount: 99,  durationDays: 30  },
  year:  { amount: 799, durationDays: 365 },
};

// month and year trigger the ₹5 referral payout; trial does not.
export const QUALIFYING_PLANS = new Set<Plan>(["month", "year"]);

export function isValidPlan(s: string): s is Plan {
  return s === "trial" || s === "month" || s === "year";
}

export function getPriceForPlan(plan: Plan): number {
  return PLAN_CONFIG[plan].amount;
}

// ── Cashfree HTTP helpers ─────────────────────────────────────────────────────

function cashfreeBaseUrl(): string {
  return env.cashfreeEnv === "prod"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
}

// Cashfree requires a 10-digit phone.  Strip country prefix if present.
function normalizePhone(phone: string | null): string {
  if (!phone) return "9999999999";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 10) return digits;
  return digits.slice(-10);
}

export async function createCashfreeOrder(params: {
  orderId: string;
  amount: number;
  customerId: string;
  customerPhone: string | null;
  returnUrl: string;
  notifyUrl: string;
}): Promise<{ cfOrderId: string; paymentSessionId: string }> {
  const url = `${cashfreeBaseUrl()}/orders`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":   "application/json",
      "x-api-version":  "2023-08-01",
      "x-client-id":    env.cashfreeClientId,
      "x-client-secret": env.cashfreeClientSecret,
    },
    body: JSON.stringify({
      order_id:       params.orderId,
      order_amount:   params.amount,
      order_currency: "INR",
      customer_details: {
        customer_id:    params.customerId.replace(/-/g, ""),
        customer_phone: normalizePhone(params.customerPhone),
      },
      order_meta: {
        return_url: params.returnUrl,
        notify_url: params.notifyUrl,
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Cashfree create-order failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as {
    cf_order_id: string;
    payment_session_id: string;
  };

  return {
    cfOrderId:        data.cf_order_id,
    paymentSessionId: data.payment_session_id,
  };
}

// ── Webhook verification ──────────────────────────────────────────────────────
// Cashfree signature: HMAC-SHA256(timestamp + rawBody, CLIENT_SECRET) → base64.
// No separator between timestamp and body — plain concatenation.

export function verifyWebhookSignature(
  rawBody: Buffer,
  timestamp: string,
  signature: string,
): boolean {
  try {
    const payload = timestamp + rawBody.toString("utf8");
    const expected = crypto
      .createHmac("sha256", env.cashfreeWebhookSecret)
      .update(payload)
      .digest("base64");

    const eBuf = Buffer.from(expected);
    const sBuf = Buffer.from(signature);
    if (eBuf.length !== sBuf.length) return false;
    return crypto.timingSafeEqual(eBuf, sBuf);
  } catch {
    return false;
  }
}

// ── Subscription application ──────────────────────────────────────────────────
// Idempotency is owned by the caller (webhook handler checks order.status first).
// This function just inserts the new subscription row.

export async function applySubscription(
  userId: string,
  plan: Plan,
): Promise<void> {
  const { durationDays } = PLAN_CONFIG[plan];
  const periodEnd = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO subscriptions (user_id, plan, status, started_at, renews_at)
     VALUES ($1, $2, 'active', now(), $3)`,
    [userId, plan, periodEnd],
  );
}
