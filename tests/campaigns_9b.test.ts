/**
 * tests/campaigns_9b.test.ts
 *
 * Step 9B — First-N signup hook and Daily-First-N substage completion hook.
 *
 * Tests:
 *   1. First-N rank assignment (sequential) — quota=null, 4 users: all 4 distinct ranks + grants
 *   2. First-N rank assignment (concurrent race) — quota=null, 5 concurrent: all 5 distinct ranks
 *   3. First-N claim eligibility — quota=3, direct inserts, no global counter: 3 grants, 4th rejected
 *   4. Daily-First-N sequential — daily_quota=2, 3 users: 1st and 2nd get grants
 *   5. Daily-First-N idempotency — same user calls hook twice: 1 grant, 1 ledger row
 *
 * Parallel-safety design:
 *   Tests 1 & 2: quota=null (unlimited) — phantom users created by auth/referral test
 *     workers can also receive grants but cannot exhaust the quota, so our test users
 *     always qualify. We assert only on our specific user IDs.
 *   Test 3: campaign type is "bonus_points" (not "first_n") so runFirstNSignupHook from
 *     parallel workers won't pick it up. claimCampaign's quota enforcement is type-agnostic.
 *     Ranks are pre-inserted directly into first_n_signups — no global counter interaction.
 *   Tests 4 & 5: daily_first_n campaigns aren't touched by runFirstNSignupHook; and
 *     runDailyFirstNHook is only called from completeSubStage, not from auth/referral flows.
 */

import "dotenv/config";
import { randomUUID, randomInt } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pool from "../src/lib/db";
import {
  claimCampaign,
  runFirstNSignupHook,
  runDailyFirstNHook,
} from "../src/services/campaigns";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePhone(): string {
  return `+91${randomInt(6_000_000_000, 9_999_999_999)}`;
}

function futureDate(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function createUser(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, phone, language, level) VALUES ($1, $2, 'hi', 1)
     ON CONFLICT (id) DO NOTHING`,
    [id, makePhone()],
  );
  testUserIds.push(id);
  return id;
}

async function insertCampaign(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = `test-9b-${randomUUID()}`;
  await pool.query(
    `INSERT INTO campaigns
       (id, name, type, active, starts_at, ends_at, award_points, quota, daily_quota)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      overrides.name ?? "9B test campaign",
      overrides.type ?? "first_n",
      overrides.active ?? true,
      overrides.starts_at ?? futureDate(-60_000),
      overrides.ends_at ?? futureDate(3_600_000),
      overrides.award_points ?? 50,
      overrides.quota ?? null,
      overrides.daily_quota ?? null,
    ],
  );
  testCampIds.push(id);
  return id;
}

// ── Resource tracking ─────────────────────────────────────────────────────────

const testUserIds: string[] = [];
const testCampIds: string[] = [];

beforeAll(async () => { /* nothing global */ });

afterAll(async () => {
  if (testCampIds.length > 0) {
    await pool.query(
      "DELETE FROM campaign_grants WHERE campaign_id = ANY($1::text[])",
      [testCampIds],
    );
    await pool.query(
      "DELETE FROM daily_first_n WHERE campaign_id = ANY($1::text[])",
      [testCampIds],
    );
    await pool.query(
      "DELETE FROM campaigns WHERE id = ANY($1::text[])",
      [testCampIds],
    );
  }
  if (testUserIds.length > 0) {
    // first_n_signups can be deleted; users cannot (wallet_ledger is append-only).
    await pool.query(
      "DELETE FROM first_n_signups WHERE user_id = ANY($1::uuid[])",
      [testUserIds],
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. First-N rank assignment — sequential
// ─────────────────────────────────────────────────────────────────────────────

describe("First-N signup hook — rank assignment (sequential)", () => {
  it("4 users, unlimited quota: all 4 get distinct ranks and grants", async () => {
    // quota=null: unlimited — parallel workers can also claim but won't exhaust it.
    const campId = await insertCampaign({ type: "first_n", quota: null });

    const users = await Promise.all([
      createUser(), createUser(), createUser(), createUser(),
    ]);

    for (const userId of users) {
      await runFirstNSignupHook(userId);
    }

    // All 4 got rows with distinct signup_ranks
    const { rows: rankRows } = await pool.query<{ signup_rank: string }>(
      `SELECT signup_rank FROM first_n_signups
       WHERE user_id = ANY($1::uuid[])
       ORDER BY signup_rank::bigint`,
      [users],
    );
    expect(rankRows).toHaveLength(4);
    const ranks = rankRows.map((r) => Number(r.signup_rank));
    expect(new Set(ranks).size).toBe(4);

    // All 4 have grants for this campaign (unlimited quota)
    const { rows: grants } = await pool.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM campaign_grants
       WHERE campaign_id = $1 AND user_id = ANY($2::uuid[])`,
      [campId, users],
    );
    expect(grants[0].cnt).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. First-N rank assignment — concurrent race
// ─────────────────────────────────────────────────────────────────────────────

describe("First-N signup hook — rank assignment (concurrent race)", () => {
  it("5 concurrent signups, unlimited quota: all 5 ranks distinct, all 5 get grants", async () => {
    const campId = await insertCampaign({ type: "first_n", quota: null });

    const users = await Promise.all([
      createUser(), createUser(), createUser(), createUser(), createUser(),
    ]);

    // All 5 hooks fire simultaneously; advisory lock serialises rank assignment.
    await Promise.all(users.map((id) => runFirstNSignupHook(id)));

    // All 5 users must have distinct signup_ranks
    const { rows: rankRows } = await pool.query<{ signup_rank: string }>(
      `SELECT signup_rank FROM first_n_signups
       WHERE user_id = ANY($1::uuid[])
       ORDER BY signup_rank::bigint`,
      [users],
    );
    expect(rankRows).toHaveLength(5);
    const ranks = rankRows.map((r) => Number(r.signup_rank));
    expect(new Set(ranks).size).toBe(5);

    // All 5 have grants (unlimited quota)
    const { rows: grants } = await pool.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM campaign_grants
       WHERE campaign_id = $1 AND user_id = ANY($2::uuid[])`,
      [campId, users],
    );
    expect(grants[0].cnt).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. First-N claim eligibility — controlled (no global counter)
// ─────────────────────────────────────────────────────────────────────────────

describe("First-N claim eligibility (controlled, no global counter)", () => {
  it("quota=3, ranks 1-4 pre-inserted: 3 grants succeed, 4th hits QUOTA_EXHAUSTED", async () => {
    // Type "bonus_points" keeps this campaign invisible to runFirstNSignupHook,
    // so parallel test workers can't exhaust our quota via their signup flows.
    // claimCampaign quota enforcement is type-agnostic.
    const campId = await insertCampaign({ type: "bonus_points", quota: 3 });
    const users = await Promise.all([
      createUser(), createUser(), createUser(), createUser(),
    ]);

    // Pre-insert known ranks — no global rank counter interaction.
    for (let i = 0; i < 4; i++) {
      await pool.query(
        "INSERT INTO first_n_signups (user_id, signup_rank) VALUES ($1, $2)",
        [users[i], i + 1],
      );
    }

    // Simulate the hook's claim loop: users with rank ≤ quota=3 can claim.
    for (let i = 0; i < 3; i++) {
      const { already_claimed } = await claimCampaign(campId, users[i], 1);
      expect(already_claimed).toBe(false);
    }

    // Rank 4 (> quota=3): quota exhausted — claim is rejected.
    await expect(claimCampaign(campId, users[3], 1)).rejects.toMatchObject({
      code: "QUOTA_EXHAUSTED",
    });

    // Exactly 3 grants; campaign counter reflects it.
    const { rows: grants } = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM campaign_grants WHERE campaign_id = $1",
      [campId],
    );
    expect(grants[0].cnt).toBe(3);

    const { rows: camp } = await pool.query<{ granted_count: number }>(
      "SELECT granted_count FROM campaigns WHERE id = $1",
      [campId],
    );
    expect(camp[0].granted_count).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Daily-First-N sequential
// ─────────────────────────────────────────────────────────────────────────────

describe("Daily-First-N hook — sequential", () => {
  it("daily_quota=2, 3 users: first 2 receive grants, 3rd does not", async () => {
    const campId = await insertCampaign({ type: "daily_first_n", daily_quota: 2 });
    const users = await Promise.all([createUser(), createUser(), createUser()]);

    for (const userId of users) {
      await runDailyFirstNHook(userId);
    }

    // daily_first_n has 3 rows with distinct ranks 1, 2, 3
    const { rows: rankRows } = await pool.query<{ rank: number }>(
      `SELECT rank FROM daily_first_n
       WHERE campaign_id = $1 AND user_id = ANY($2::uuid[])
       ORDER BY rank`,
      [campId, users],
    );
    expect(rankRows).toHaveLength(3);
    expect(rankRows.map((r) => r.rank)).toEqual([1, 2, 3]);

    // Only users[0] and users[1] have campaign grants
    const { rows: grants } = await pool.query<{ user_id: string }>(
      "SELECT user_id FROM campaign_grants WHERE campaign_id = $1",
      [campId],
    );
    expect(grants).toHaveLength(2);
    const grantedIds = grants.map((g) => g.user_id);
    expect(grantedIds).toContain(users[0]);
    expect(grantedIds).toContain(users[1]);
    expect(grantedIds).not.toContain(users[2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Daily-First-N idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("Daily-First-N hook — idempotency", () => {
  it("same user calling hook twice on the same day: 1 grant, 1 ledger row", async () => {
    const campId = await insertCampaign({
      type: "daily_first_n",
      daily_quota: 5,
      award_points: 30,
    });
    const userId = await createUser();

    await runDailyFirstNHook(userId);
    await runDailyFirstNHook(userId); // second call — must be a no-op

    // Exactly one grant row
    const { rows: grants } = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM campaign_grants WHERE campaign_id = $1 AND user_id = $2",
      [campId, userId],
    );
    expect(grants[0].cnt).toBe(1);

    // Exactly one ledger row
    const { rows: ledger } = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM wallet_ledger WHERE idempotency_key = $1",
      [`promo:${campId}:${userId}`],
    );
    expect(ledger[0].cnt).toBe(1);

    // Exactly one daily_first_n row
    const { rows: daily } = await pool.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM daily_first_n WHERE campaign_id = $1 AND user_id = $2",
      [campId, userId],
    );
    expect(daily[0].cnt).toBe(1);
  });
});
