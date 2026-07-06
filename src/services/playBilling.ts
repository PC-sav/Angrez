import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { env } from "../config/env";
import pool from "../lib/db";
import type { Plan } from "./payments";

// ── Product catalogue ─────────────────────────────────────────────────────────
// Play Console product IDs (Block 0, P0.12). Must match exactly what's created
// there — an unrecognised productId is a fail-closed no-write, not a guess.
// 'trial' has no Play product: the ₹9 tier is an intro offer on the 'month'
// plan (Play reports SUBSCRIPTION_STATE_ACTIVE with productId 'angrez_month'
// either way).

const PRODUCT_ID_TO_PLAN: Record<string, Plan> = {
  angrez_month: "month",
  angrez_year: "year",
};

// ── SubscriptionsV2 state → our status vocabulary ─────────────────────────────
// CANCELED means auto-renew is off but the user is still inside their paid
// period — it is NOT a revocation. Revocation is signaled separately, later,
// by EXPIRED once the paid period actually ends. So CANCELED maps to active
// (renews_at still carries the real expiry — the eventual EXPIRED notification
// is what performs the actual access cutoff, not this one).
//
// Locked vocabulary (no pre-existing one existed — /api/subscription only ever
// queries `WHERE status = 'active'`, so these non-'active' strings are for
// operator legibility in Railway logs / manual DB inspection, not read paths):
// on_hold | paused | expired. No "canceled" or "inactive" status string exists —
// an unrecognised subscriptionState fails closed (no write), it never guesses.

const ACTIVE_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  "SUBSCRIPTION_STATE_CANCELED",
]);

const NON_ACTIVE_STATUS: Record<string, string> = {
  SUBSCRIPTION_STATE_ON_HOLD: "on_hold",
  SUBSCRIPTION_STATE_PAUSED: "paused",
  SUBSCRIPTION_STATE_EXPIRED: "expired",
};

export interface SubscriptionsV2LineItem {
  productId: string;
  expiryTime: string;
}

export interface SubscriptionsV2Response {
  subscriptionState: string;
  lineItems: SubscriptionsV2LineItem[];
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
}

export type MappingResult =
  | { write: false; reason: string }
  | { write: true; status: string; plan: Plan; renewsAt: Date };

// Pure — no I/O. The payload only tells us which purchase token to look up;
// state always comes from this freshly-fetched subscriptionsv2 response, never
// from the RTDN notification body itself.
export function mapSubscriptionState(resp: SubscriptionsV2Response): MappingResult {
  const lineItem = resp.lineItems[0];
  if (!lineItem) {
    return { write: false, reason: "no line items in subscriptionsv2 response" };
  }

  const plan = PRODUCT_ID_TO_PLAN[lineItem.productId];
  if (!plan) {
    return { write: false, reason: `unknown productId: ${lineItem.productId}` };
  }

  // Mirrors Cashfree's CREATED orders: no subscriptions row until there's
  // something real to grant or record.
  if (resp.subscriptionState === "SUBSCRIPTION_STATE_PENDING") {
    return { write: false, reason: "pending — no row until resolved" };
  }

  if (ACTIVE_STATES.has(resp.subscriptionState)) {
    return { write: true, status: "active", plan, renewsAt: new Date(lineItem.expiryTime) };
  }

  const nonActiveStatus = NON_ACTIVE_STATUS[resp.subscriptionState];
  if (!nonActiveStatus) {
    // Fail closed — an unrecognised state (future API addition) never guesses
    // at a status string; it leaves the vocabulary undefined and writes nothing.
    return { write: false, reason: `unknown subscriptionState: ${resp.subscriptionState}` };
  }

  return { write: true, status: nonActiveStatus, plan, renewsAt: new Date(lineItem.expiryTime) };
}

// ── Idempotent write ───────────────────────────────────────────────────────────
// ON CONFLICT (user_id, payu_ref) DO UPDATE — RTDN redelivery and legitimate
// state transitions (ACTIVE → EXPIRED) both land here. Idempotent means
// convergent, not write-once: started_at is untouched by the UPDATE branch.

export async function applyPlaySubscriptionWrite(params: {
  userId: string;
  purchaseToken: string;
  plan: Plan;
  status: string;
  renewsAt: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO subscriptions (user_id, plan, status, started_at, renews_at, payu_ref)
     VALUES ($1, $2, $3, now(), $4, $5)
     ON CONFLICT (user_id, payu_ref) DO UPDATE
     SET status = EXCLUDED.status, renews_at = EXCLUDED.renews_at, plan = EXCLUDED.plan`,
    [params.userId, params.plan, params.status, params.renewsAt, params.purchaseToken],
  );
}

// ── Play Developer API (REST + GoogleAuth — no `googleapis` SDK dependency) ───

interface ServiceAccountJson {
  client_email: string;
  [key: string]: unknown;
}

function parseServiceAccount(): ServiceAccountJson {
  return JSON.parse(env.googlePlayServiceAccountJson) as ServiceAccountJson;
}

let cachedAuth: GoogleAuth | null = null;

function getGoogleAuth(): GoogleAuth {
  if (!cachedAuth) {
    cachedAuth = new GoogleAuth({
      credentials: parseServiceAccount(),
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
  }
  return cachedAuth;
}

// 4xx from the Play API is a permanent failure (bad/expired/revoked token,
// malformed request) — retrying won't help, so the route acks (no Pub/Sub
// redelivery) instead of 503ing. 5xx/network errors stay transient — thrown
// as a plain Error, caught by the route's existing isConnectionError() 503 path.
export class PlayApiPermanentError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlayApiPermanentError";
  }
}

// Pure — no I/O. Isolated from fetchSubscriptionV2 so the 4xx-vs-5xx split is
// unit-testable without mocking GoogleAuth/network.
export function classifyPlayApiFailure(status: number, body: string): Error {
  const message = `Play subscriptionsv2.get failed (${status}): ${body}`;
  return status >= 400 && status < 500 ? new PlayApiPermanentError(status, message) : new Error(message);
}

export async function fetchSubscriptionV2(purchaseToken: string): Promise<SubscriptionsV2Response> {
  const client = await getGoogleAuth().getClient();
  const { token } = await client.getAccessToken();

  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${env.googlePlayPackageName}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!resp.ok) {
    throw classifyPlayApiFailure(resp.status, await resp.text());
  }

  return (await resp.json()) as SubscriptionsV2Response;
}

// ── Pub/Sub push authentication ───────────────────────────────────────────────
// GPB analogue of the Cashfree HMAC check (src/services/payments.ts
// verifyWebhookSignature): Google doesn't sign the body, it authenticates the
// push REQUEST via an OIDC bearer token issued by the configured service account.

const oidcClient = new OAuth2Client();

export async function verifyPubSubPushToken(idToken: string): Promise<boolean> {
  try {
    const ticket = await oidcClient.verifyIdToken({
      idToken,
      audience: env.googlePlayPubsubAudience,
    });
    const payload = ticket.getPayload();
    if (!payload) return false;
    if (payload.iss !== "https://accounts.google.com") return false;
    if (payload.email !== parseServiceAccount().client_email) return false;
    if (payload.email_verified !== true) return false;
    return true;
  } catch {
    return false;
  }
}
