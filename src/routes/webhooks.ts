import { Router, Request, Response } from "express";
import { errResponse, isConnectionError } from "../lib/errors";
import pool from "../lib/db";
import {
  verifyPubSubPushToken,
  fetchSubscriptionV2,
  mapSubscriptionState,
  applyPlaySubscriptionWrite,
  PlayApiPermanentError,
} from "../services/playBilling";

const router = Router();

// 8-4-4-4-12 hex, case-insensitive — same pattern as src/routes/learning.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

interface PubSubPushBody {
  message?: { data?: string };
  subscription?: string;
}

interface DecodedNotification {
  packageName?: string;
  testNotification?: { version: string };
  subscriptionNotification?: {
    version: string;
    notificationType: number;
    purchaseToken: string;
    subscriptionId: string;
  };
}

// ── POST /api/webhooks/play ────────────────────────────────────────────────────
// NO auth middleware — the Pub/Sub push OIDC bearer token IS the auth.
//
// Mounted under normal express.json() — unlike the Cashfree webhook, Pub/Sub
// authenticates the *request* (bearer token), not the body bytes, so no raw-body
// capture is needed here.
//
// Doctrine (same as Cashfree): the notification payload tells us WHEN and WHICH
// purchase token; it never tells us WHAT the state is. State always comes from a
// fresh purchases.subscriptionsv2.get call. Fail closed: an unresolvable user or
// unverifiable push writes nothing, ever.

router.post("/play", async (req: Request, res: Response): Promise<void> => {
  // 1. Verify the Pub/Sub push OIDC bearer token.
  const authHeader = req.headers.authorization;
  const bearerMatch = authHeader?.match(/^Bearer (.+)$/);

  if (!bearerMatch || !(await verifyPubSubPushToken(bearerMatch[1]))) {
    console.error("[webhooks/play] OIDC push token verification failed");
    res.status(401).json(errResponse("PUSH_AUTH_INVALID", "Push token verification failed."));
    return;
  }

  // Set once the purchase token is known, so the catch block can log it too.
  let purchaseTokenTail: string | undefined;

  try {
    // 2. Decode message.data (base64 JSON).
    const body = req.body as PubSubPushBody;
    const dataB64 = body.message?.data;

    if (!dataB64) {
      console.warn("[webhooks/play] push envelope has no message.data");
      res.status(200).json({ received: true });
      return;
    }

    let notification: DecodedNotification;
    try {
      notification = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8")) as DecodedNotification;
    } catch {
      console.warn("[webhooks/play] failed to parse message.data JSON");
      res.status(200).json({ received: true });
      return;
    }

    const sub = notification.subscriptionNotification;

    if (!sub) {
      // testNotification, or a notification type we don't act on (e.g. a
      // future one-time-product notification) — ack, no processing.
      console.log("[webhooks/play] non-subscription notification acked", {
        hasTestNotification: !!notification.testNotification,
      });
      res.status(200).json({ received: true });
      return;
    }

    purchaseTokenTail = sub.purchaseToken.slice(-8);

    // 3. Re-fetch the purchase from the Play Developer API — never trust the
    //    notification payload for state, only for which token to look up.
    const subResp = await fetchSubscriptionV2(sub.purchaseToken);

    // 4. Resolve the user. Fail-closed gate: no matching/parseable user → log,
    //    ack (stop Pub/Sub redelivery — the failure is ours to investigate),
    //    no write.
    const obfuscatedId = subResp.externalAccountIdentifiers?.obfuscatedExternalAccountId;

    if (!isValidUUID(obfuscatedId)) {
      console.error("[webhooks/play] obfuscatedExternalAccountId missing or not a UUID", {
        tokenTail: purchaseTokenTail,
      });
      res.status(200).json({ received: true });
      return;
    }

    const userRes = await pool.query<{ id: string }>("SELECT id FROM users WHERE id = $1", [obfuscatedId]);

    if (!userRes.rows[0]) {
      console.error("[webhooks/play] obfuscatedExternalAccountId does not match a known user", {
        tokenTail: purchaseTokenTail,
      });
      res.status(200).json({ received: true });
      return;
    }

    // 5. Map state and write.
    const mapping = mapSubscriptionState(subResp);

    if (!mapping.write) {
      // "unknown subscriptionState" means a future Play API state we don't
      // recognise yet — that's a code/config gap worth paging on, not routine.
      const logFn = mapping.reason.startsWith("unknown subscriptionState") ? console.error : console.log;
      logFn("[webhooks/play] no write:", mapping.reason, { tokenTail: purchaseTokenTail });
      res.status(200).json({ received: true });
      return;
    }

    await applyPlaySubscriptionWrite({
      userId: obfuscatedId,
      purchaseToken: sub.purchaseToken,
      plan: mapping.plan,
      status: mapping.status,
      renewsAt: mapping.renewsAt,
    });

    res.status(200).json({ received: true });
  } catch (err) {
    if (err instanceof PlayApiPermanentError) {
      // Bad/expired/revoked token, malformed request — retrying changes
      // nothing. Ack so Pub/Sub stops redelivering; no write.
      console.error("[webhooks/play] permanent Play API error — acking, no write", {
        status: err.status,
        tokenTail: purchaseTokenTail,
      });
      res.status(200).json({ received: true });
      return;
    }
    if (isConnectionError(err)) {
      // Genuine transient infra failure — 5xx so Pub/Sub redelivers, unlike
      // every fail-closed branch above which acks deliberately.
      res
        .set("Retry-After", "5")
        .status(503)
        .json(errResponse("SERVICE_UNAVAILABLE", "Service temporarily unavailable, please retry."));
      return;
    }
    console.error("[webhooks/play] unhandled error", err);
    res.status(500).json(errResponse("INTERNAL_ERROR", "Internal server error."));
  }
});

export default router;
