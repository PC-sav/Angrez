/**
 * tests/support/testDb.ts
 *
 * Test-side DB pool — the ONLY module test files should import for DB access.
 * Reads TEST_DATABASE_URL and ONLY TEST_DATABASE_URL (invariant 1). The server's
 * own pool (src/lib/db.ts) is untouched and keeps reading DATABASE_URL — this
 * wrapper exists so the server module never becomes env-aware (invariant 4).
 *
 * assertTestDatabaseSafe() is called again here (globalSetup already called it
 * once for the whole run) as defense in depth: this module refuses on its own
 * merits if it's ever imported outside the globalSetup-fenced run.
 */

import { Pool } from "pg";
import { assertTestDatabaseSafe } from "./fence";

assertTestDatabaseSafe();

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL!;

const pool = new Pool({
  connectionString: TEST_DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5000,
  ssl: TEST_DATABASE_URL.includes("supabase.co") ? { rejectUnauthorized: false } : undefined,
});

export default pool;
