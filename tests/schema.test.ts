/**
 * tests/schema.test.ts
 *
 * Safety tests for wallet_ledger database-level constraints.
 *
 * Each test runs inside a BEGIN/ROLLBACK transaction so no data is
 * permanently written to the database. Expected failures are wrapped in
 * SAVEPOINTs so the connection stays usable after the error.
 *
 * Prerequisites: run `npm run migrate` against the TEST database and make
 * sure TEST_DATABASE_URL is set in .env.
 *
 * This file builds its own pg.Client (for per-test BEGIN/ROLLBACK) rather than
 * sharing the pool in tests/support/testDb.ts — it still reads ONLY
 * TEST_DATABASE_URL and calls assertTestDatabaseSafe() itself (invariant 1).
 */

import "dotenv/config";
import { describe, it, expect } from "vitest";
import { Client } from "pg";
import { assertTestDatabaseSafe } from "./support/fence";

assertTestDatabaseSafe();

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL!;

function makeClient(): Client {
  const ssl = TEST_DATABASE_URL.includes("supabase.co")
    ? { rejectUnauthorized: false }
    : undefined;
  return new Client({ connectionString: TEST_DATABASE_URL, ssl });
}

/**
 * Open a client, run fn inside a transaction, always ROLLBACK.
 * Use SAVEPOINT around queries expected to fail so the connection
 * recovers and the outer ROLLBACK can still clean up.
 */
async function withRollback<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = makeClient();
  await client.connect();
  await client.query("BEGIN");
  try {
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

/** Insert a throw-away test user; returns its UUID. */
async function insertTestUser(client: Client, tag: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO users (phone) VALUES ($1) RETURNING id",
    [`+00000000000_test_${tag}_${Date.now()}`]
  );
  return rows[0].id;
}

/** Insert a ledger row; returns its UUID. */
async function insertLedgerRow(
  client: Client,
  userId: string,
  idemKey: string
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key)
     VALUES ($1, 10, 'test-earn', $2) RETURNING id`,
    [userId, idemKey]
  );
  return rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("wallet_ledger — append-only enforcement", () => {
  it("rejects UPDATE on an existing row", async () => {
    await withRollback(async (client) => {
      const userId = await insertTestUser(client, "upd");
      const ledgerId = await insertLedgerRow(client, userId, `idem-upd-${Date.now()}`);

      // Wrap the expected failure in a SAVEPOINT so the transaction survives.
      await client.query("SAVEPOINT sp");
      await expect(
        client.query(
          "UPDATE wallet_ledger SET delta_points = 999 WHERE id = $1",
          [ledgerId]
        )
      ).rejects.toThrow(/append-only/i);
      await client.query("ROLLBACK TO SAVEPOINT sp");
    });
  });

  it("rejects DELETE on an existing row", async () => {
    await withRollback(async (client) => {
      const userId = await insertTestUser(client, "del");
      const ledgerId = await insertLedgerRow(client, userId, `idem-del-${Date.now()}`);

      await client.query("SAVEPOINT sp");
      await expect(
        client.query("DELETE FROM wallet_ledger WHERE id = $1", [ledgerId])
      ).rejects.toThrow(/append-only/i);
      await client.query("ROLLBACK TO SAVEPOINT sp");
    });
  });

  it("rejects a duplicate idempotency_key on a second INSERT", async () => {
    await withRollback(async (client) => {
      const userId = await insertTestUser(client, "dup");
      const key = `idem-dup-${Date.now()}`;

      // First insert — must succeed.
      await insertLedgerRow(client, userId, key);

      // Second insert with same key — must fail on the UNIQUE constraint.
      await client.query("SAVEPOINT sp");
      await expect(
        client.query(
          `INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key)
           VALUES ($1, 5, 'duplicate-attempt', $2)`,
          [userId, key]
        )
      ).rejects.toThrow(/unique/i);
      await client.query("ROLLBACK TO SAVEPOINT sp");
    });
  });
});
