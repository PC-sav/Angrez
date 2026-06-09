/**
 * scripts/migrate.ts
 *
 * Minimal migration runner for Angrez.
 *
 * Usage:
 *   npm run migrate          — apply all pending *.sql migrations (skips applied ones)
 *   npm run migrate:undo     — roll back the most-recently applied migration
 *   npm run migrate:status   — list applied migrations
 *
 * How it works:
 *   - Migrations live in migrations/ and are named NNN_description.sql
 *   - Applied migrations are tracked in the schema_migrations table (auto-created).
 *   - Rollback files are named NNN_description.undo.sql (same prefix).
 *   - Every migration runs inside a transaction; a failure triggers ROLLBACK.
 */

import "dotenv/config";
import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set in environment");

const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

function pgClient(): Client {
  const ssl = DATABASE_URL!.includes("supabase.co")
    ? { rejectUnauthorized: false }
    : undefined;
  return new Client({ connectionString: DATABASE_URL, ssl });
}

async function ensureTrackingTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedSet(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations ORDER BY filename"
  );
  return new Set(rows.map((r) => r.filename));
}

async function runUp(): Promise<void> {
  const client = pgClient();
  await client.connect();
  try {
    await ensureTrackingTable(client);
    const applied = await appliedSet(client);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_.*\.sql$/.test(f) && !f.endsWith(".undo.sql"))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip   ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`  apply  ${file}`);
        ran++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    console.log(ran === 0 ? "Nothing to apply." : `Done — ${ran} migration(s) applied.`);
  } finally {
    await client.end();
  }
}

async function runDown(): Promise<void> {
  const client = pgClient();
  await client.connect();
  try {
    await ensureTrackingTable(client);
    const applied = await appliedSet(client);
    const last = [...applied].sort().pop();
    if (!last) {
      console.log("Nothing to roll back.");
      return;
    }
    const undoName = last.replace(/\.sql$/, ".undo.sql");
    const undoPath = path.join(MIGRATIONS_DIR, undoName);
    if (!fs.existsSync(undoPath)) {
      throw new Error(`Undo file not found: ${undoName}`);
    }
    const sql = fs.readFileSync(undoPath, "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("DELETE FROM schema_migrations WHERE filename = $1", [last]);
      await client.query("COMMIT");
      console.log(`  undo   ${last}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    console.log("Done.");
  } finally {
    await client.end();
  }
}

async function runStatus(): Promise<void> {
  const client = pgClient();
  await client.connect();
  try {
    await ensureTrackingTable(client);
    const { rows } = await client.query<{ filename: string; applied_at: Date }>(
      "SELECT filename, applied_at FROM schema_migrations ORDER BY filename"
    );
    if (rows.length === 0) {
      console.log("No migrations applied.");
    } else {
      rows.forEach((r) =>
        console.log(`  applied  ${r.filename}  at ${r.applied_at.toISOString()}`)
      );
    }
  } finally {
    await client.end();
  }
}

const cmd = process.argv[2];
const runner =
  cmd === "--down"   ? runDown   :
  cmd === "--status" ? runStatus :
  runUp;

runner().catch((err) => {
  console.error("Migration error:", err.message);
  process.exit(1);
});
