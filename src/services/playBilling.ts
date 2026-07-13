import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { env } from "../config/env";
import pool from "../lib/db";
import type { Plan } from "./payments";

// ── Base plan catalogue ────────────────────────────────────────────────────────
// Play Console base plan IDs (Block 0, P0.12) — NOT the top-level productId.
// A single product (e.g. angrez_month) can carry more than one base plan —
// angrez_month currently has a dead prepaid base plan literally named "monthly"
// alongside the real "monthly-std" — so productId alone doesn't tell us which
// plan the user actually bought. An unrecognised basePlanId is a fail-closed
// no-write, not a guess. 'trial' has no Play product of its own: the ₹9 tier is
// the 'intro-9' offer ON the 'monthly-std' base plan — map by base plan, not by
// offer, since offerId identifies the discount, not the plan.

const BASE_PLAN_ID_TO_PLAN: Record<string, Plan> = {
  "monthly-std": "month",
  "yearly": "year",
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
  offerDetails?: {
    basePlanId: string;
    offerId?: string;
  };
}

export interface SubscriptionsV2Response {
  subscriptionState: string;
  lineItems: SubscriptionsV2LineItem[];
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  // Top-level on the resource (confirmed against Google's current API docs,
  // NOT per-lineItem) — already present in the same payload fetched for the
  // grant, so reading it for Block 1.1's server-side ack is zero extra API
  // reads. 'ACKNOWLEDGEMENT_STATE_PENDING' | 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'.
  acknowledgementState: string;
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

  const basePlanId = lineItem.offerDetails?.basePlanId;
  if (!basePlanId) {
    return { write: false, reason: "no offerDetails.basePlanId in lineItem" };
  }

  const plan = BASE_PLAN_ID_TO_PLAN[basePlanId];
  if (!plan) {
    return { write: false, reason: `unknown basePlanId: ${basePlanId}` };
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

// ── Server-side acknowledgement (Block 1.1) ───────────────────────────────────
// Client-side ack alone has a hole: if the app closes between purchase and
// ack, or a pending purchase resolves while the app is closed, no ack ever
// fires — Google auto-refunds at 72h even though the webhook already granted
// the subscription. This is a NEW step strictly AFTER a successful grant; it
// never gates, replaces, or precedes the grant write.
//
// State-driven, no notification-type allowlist (approved deviation from an
// earlier draft): acknowledgementState is read from the SAME subscriptionsv2
// response already fetched for the grant — Google's own reported state is
// ground truth for whether an ack is still owed, regardless of whether this
// notification was a PURCHASED, RENEWED, or RECOVERED event.

export type AckDecision = "attempt" | "already-acknowledged" | "not-required";

// Pure — no I/O. Missing/unrecognised acknowledgementState (should not occur
// against the documented API, but never guessed at) resolves to "not-required":
// skip the ack call rather than risk one against an uncertain state, since
// retrying it would just see the same uncertain value again.
export function decideAcknowledgement(acknowledgementState: string | undefined): AckDecision {
  if (acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING") return "attempt";
  if (acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED") return "already-acknowledged";
  return "not-required";
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

// ── Server-side acknowledgement call ──────────────────────────────────────────
// No purchases.subscriptionsv2.acknowledge exists (confirmed against Google's
// current API docs) — acknowledgement is still only on the older v1-shaped
// resource: purchases.subscriptions.acknowledge. Same bearer-token pattern as
// fetchSubscriptionV2, no `googleapis` dependency. subscriptionId is the
// notification's `subscriptionNotification.subscriptionId` (Google's name for
// what we call productId, e.g. "angrez_month") — marked optional/"not
// recommended" by Google since May 2025 only for subscriptions WITH add-ons;
// we have none, so it's still passed.

export class PlayAckPermanentError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlayAckPermanentError";
  }
}

// Pure — no I/O. Mirrors classifyPlayApiFailure's 4xx/5xx split for the ack
// call, with one addition: a 4xx whose body indicates the purchase was
// already acknowledged is success (null), not failure — idempotent ack, since
// the client's own finishTransaction() may have raced us to it.
//
// FLAGGED (per design review): Google does not publish a stable
// machine-readable error code for "already acknowledged" on this endpoint —
// detection is a best-effort case-insensitive substring match. Confirm at the
// live G2 gate against a real client/server ack race.
//
// Classification lean for a confirmed non-already-acked 4xx vs 5xx/other:
//   4xx (not already-acked) → PERMANENT. Retrying won't change a rejected
//     request. The grant already stands (this only runs after a successful
//     write) — thrown as PlayAckPermanentError so the route ACKS Pub/Sub
//     (redelivery can't fix a permanent rejection, same reasoning
//     classifyPlayApiFailure applies on the fetch side) but logs CRITICAL:
//     an un-acknowledgeable purchase auto-refunds at 72h regardless.
//   5xx / anything else (including a thrown network exception, which never
//     reaches this function at all and is caught as-is by the route) →
//     TRANSIENT by default. This is the safer lean for an ambiguous failure:
//     the route does NOT ack Pub/Sub, so redelivery retries the whole
//     grant+ack pair (grant re-converges via ON CONFLICT, ack re-attempts).
export function classifyAckFailure(status: number, body: string): Error | null {
  if (status >= 200 && status < 300) return null;

  if (status >= 400 && status < 500) {
    if (/already.*acknowledg/i.test(body)) return null;
    return new PlayAckPermanentError(status, `Play acknowledge failed (${status}): ${body}`);
  }

  return new Error(`Play acknowledge failed (${status}): ${body}`);
}

export async function acknowledgeSubscriptionPurchase(
  subscriptionId: string,
  purchaseToken: string,
): Promise<void> {
  const client = await getGoogleAuth().getClient();
  const { token } = await client.getAccessToken();

  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${env.googlePlayPackageName}/purchases/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  const err = classifyAckFailure(resp.status, resp.ok ? "" : await resp.text());
  if (err) throw err;
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
