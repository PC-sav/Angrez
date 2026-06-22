import { Router, Request, Response } from "express";
import crypto from "crypto";
import { requireAuth } from "../middleware/auth";
import { errResponse, isConnectionError } from "../lib/errors";
import { env } from "../config/env";
import pool from "../lib/db";
import {
  isValidPlan,
  getPriceForPlan,
  resolvePrice,
  QUALIFYING_PLANS,
  createCashfreeOrder,
  verifyWebhookSignature,
  applySubscription,
  type Plan,
} from "../services/payments";
import { creditReferral } from "../services/referrals";
import { consumePricingQuota } from "../services/campaigns";

const router = Router();

function handleError(err: unknown, res: Response): void {
  if (isConnectionError(err)) {
    res
      .set("Retry-After", "5")
      .status(503)
      .json(errResponse("SERVICE_UNAVAILABLE", "Service temporarily unavailable, please retry."));
    return;
  }
  console.error(err);
  res.status(500).json(errResponse("INTERNAL_ERROR", "Internal server error."));
}

// ── POST /api/payments/order ──────────────────────────────────────────────────
// Auth required.  Client sends { plan }.  Server resolves amount, creates the
// Cashfree order, stores our orders row, and returns { order_id, payment_session_id, amount }.

router.post("/order", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { plan } = req.body as { plan?: string };

    if (!plan || !isValidPlan(plan)) {
      res.status(400).json(errResponse("INVALID_PLAN", `Plan must be one of: trial, month, year.`));
      return;
    }

    const user = req.user!;

    // resolvePrice is the single price authority: checks active early_bird_price
    // campaigns first, falls back to PLAN_CONFIG.  Amount is frozen at create-time.
    const { amount, campaign_id } = await resolvePrice(plan as Plan);

    // Unique order ID — 'ord_' prefix + 32 hex chars.
    const orderId = `ord_${crypto.randomBytes(16).toString("hex")}`;

    // Store our order record first (CREATED status).  campaign_id records which
    // pricing campaign set this amount; null when no campaign applied.
    await pool.query(
      `INSERT INTO orders (order_id, user_id, plan, amount, campaign_id) VALUES ($1, $2, $3, $4, $5)`,
      [orderId, user.id, plan, amount, campaign_id],
    );

    // Create the order on Cashfree.
    const { cfOrderId, paymentSessionId } = await createCashfreeOrder({
      orderId,
      amount,
      customerId:    user.id,
      customerPhone: user.phone,
      returnUrl:     `${env.appBaseUrl}/payment/complete?order_id=${orderId}`,
      notifyUrl:     `${env.appBaseUrl}/api/payments/webhook`,
    });

    // Persist cf_order_id now that we have it.
    await pool.query(
      `UPDATE orders SET cf_order_id = $1, updated_at = now() WHERE order_id = $2`,
      [cfOrderId, orderId],
    );

    res.json({ order_id: orderId, payment_session_id: paymentSessionId, amount });
  } catch (err) {
    handleError(err, res);
  }
});

// ── POST /api/payments/webhook ────────────────────────────────────────────────
// NO auth — Cashfree signature IS the auth.
//
// CRITICAL: This route uses express.raw() mounted in app.ts BEFORE express.json().
// req.body is a Buffer here.  Signature is verified against raw bytes.
// Never credit or grant subscription from a client callback — only from here.

router.post("/webhook", async (req: Request, res: Response): Promise<void> => {
  const rawBody  = req.body as Buffer;
  const signature = req.headers["x-webhook-signature"] as string | undefined;
  const timestamp = req.headers["x-webhook-timestamp"] as string | undefined;

  // 1. Verify signature — reject immediately on mismatch.
  if (!signature || !timestamp || !verifyWebhookSignature(rawBody, timestamp, signature)) {
    console.error("[webhook] signature verification failed", { signature, timestamp });
    res.status(401).json(errResponse("WEBHOOK_SIGNATURE_INVALID", "Signature mismatch."));
    return;
  }

  // 2. Parse body.
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    console.error("[webhook] failed to parse body");
    res.status(400).json(errResponse("WEBHOOK_PARSE_ERROR", "Invalid JSON."));
    return;
  }

  // 3. Diagnostic — log full body and event-type header on every verified webhook.
  //    Permanent debug log: lets us see exact payload shape from Railway logs.
  console.log("[webhook] RAW body:", JSON.stringify(event));
  console.log("[webhook] type header:", req.headers["x-webhook-event"] ?? "(none)");

  // 4. Extract fields with a fallback chain that covers the 2023-08-01 nested
  //    shape, older nesting, and flat (test-ping) shapes.
  const data      = event.data  as Record<string, unknown> | undefined;
  const orderData = data?.order  as Record<string, unknown> | undefined;
  const payment   = data?.payment as Record<string, unknown> | undefined;

  const orderId: string | null =
    (orderData?.order_id as string | undefined) ??           // 2023-08-01 success/failed
    ((event.order as Record<string, unknown>)?.order_id as string | undefined) ?? // older nesting
    (event.order_id as string | undefined) ??                // flat
    null;

  const paymentStatus = payment?.payment_status as string | undefined;

  // payment_amount is preferred; fall back to order_amount for older shapes.
  const paidAmount: number | undefined =
    (payment?.payment_amount as number | undefined) ??
    (orderData?.order_amount as number | undefined);

  // Test pings and unrecognised event shapes have no order_id — ack without action.
  if (!orderId) {
    console.warn(
      "[webhook] no order_id found. top-level keys:", Object.keys(event),
      "| data keys:", data ? Object.keys(data) : "(no data)",
    );
    res.status(200).json({ received: true });
    return;
  }

  // 4. Look up our order record.
  const orderRes = await pool.query<{
    order_id:    string;
    user_id:     string;
    plan:        Plan;
    amount:      number;
    status:      string;
    campaign_id: string | null;
  }>(
    `SELECT order_id, user_id, plan, amount, status, campaign_id FROM orders WHERE order_id = $1`,
    [orderId],
  );

  if (!orderRes.rows[0]) {
    // Unknown order — ack so Cashfree doesn't retry forever.
    console.warn("[webhook] order not found in DB", { orderId });
    res.status(200).json({ received: true });
    return;
  }

  const dbOrder = orderRes.rows[0];

  // 5. Non-success events — update our status and ack.
  if (paymentStatus !== "SUCCESS") {
    const newStatus = paymentStatus === "USER_DROPPED" ? "DROPPED" : "FAILED";
    if (dbOrder.status === "CREATED") {
      await pool.query(
        `UPDATE orders SET status = $1, updated_at = now() WHERE order_id = $2`,
        [newStatus, orderId],
      );
    }
    res.status(200).json({ received: true });
    return;
  }

  // 6. Amount tamper check — a mismatch is alert-worthy; do NOT grant anything.
  if (paidAmount !== undefined && Math.round(paidAmount) !== dbOrder.amount) {
    console.error("[webhook] AMOUNT MISMATCH — possible tamper", {
      orderId,
      expected: dbOrder.amount,
      received: paidAmount,
    });
    // Ack so Cashfree stops retrying, but take no action.
    res.status(200).json({ received: true });
    return;
  }

  // 7. Idempotent transition CREATED → PAID + pricing-quota increment (atomic).
  //    The WHERE status='CREATED' guard is the serialisation point: only the first
  //    webhook delivery wins the UPDATE; any replay sees rowCount 0 and skips the
  //    entire block — including the quota bump — so granted_count never double-counts.
  const txClient = await pool.connect();
  let didTransition = false;
  try {
    await txClient.query("BEGIN");

    const updated = await txClient.query<{ order_id: string }>(
      `UPDATE orders SET status = 'PAID', updated_at = now()
       WHERE order_id = $1 AND status = 'CREATED'
       RETURNING order_id`,
      [orderId],
    );

    if ((updated.rowCount ?? 0) > 0) {
      didTransition = true;
      // Bump the pricing-campaign counter when this order was campaign-priced.
      // consumePricingQuota silently no-ops if quota is already full — never
      // blocks a payment that was already accepted at a campaign price.
      if (dbOrder.campaign_id) {
        await consumePricingQuota(dbOrder.campaign_id, txClient);
      }
    }

    await txClient.query("COMMIT");
  } catch (txErr) {
    await txClient.query("ROLLBACK").catch(() => {});
    txClient.release();
    throw txErr;
  }
  txClient.release();

  if (!didTransition) {
    // Already processed (duplicate webhook or concurrent retry).
    res.status(200).json({ received: true });
    return;
  }

  // 8. Apply subscription (inside the same logical step as the PAID transition).
  try {
    await applySubscription(dbOrder.user_id, dbOrder.plan);
  } catch (subErr) {
    // Log but don't re-throw — we don't want Cashfree to retry a paid webhook
    // and cause a double-subscription insert.  Manual remediation if this fires.
    console.error("[webhook] applySubscription failed — manual remediation needed", {
      orderId,
      userId: dbOrder.user_id,
      error:  subErr,
    });
  }

  // 9. Referral payout — only if the referee has a pending referral AND the
  //    plan is qualifying (month or year, not trial).
  //    creditReferral's own idempotency key (referral:{referrer}:{referee})
  //    guarantees at-most-once credit even if this block is reached again.
  if (QUALIFYING_PLANS.has(dbOrder.plan)) {
    try {
      const referralRes = await pool.query<{ referrer_id: string }>(
        `SELECT referrer_id FROM referrals
         WHERE referred_id = $1 AND bonus_state = 'pending'`,
        [dbOrder.user_id],
      );
      if (referralRes.rows[0]) {
        await creditReferral(referralRes.rows[0].referrer_id, dbOrder.user_id);
      }
    } catch (refErr) {
      console.error("[webhook] creditReferral failed", {
        orderId,
        userId: dbOrder.user_id,
        error:  refErr,
      });
    }
  }

  res.status(200).json({ received: true });
});

export default router;
