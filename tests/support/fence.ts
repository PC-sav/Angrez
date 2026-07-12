/**
 * tests/support/fence.ts
 *
 * TEST FENCE — see CC handoff "test fence: TEST_DATABASE_URL required + prod-host
 * deny guard" (9 Jul). npm test has wiped production content twice because test
 * files connected via whatever DATABASE_URL resolved to. This module makes that
 * structurally impossible rather than procedurally avoided.
 *
 * assertTestDatabaseSafe() is a pure function of process.env — no DB connection
 * is opened here, so it is unit-testable without a database (see fence.test.ts)
 * and safe to call as the very first thing in the test run (globalSetup) and
 * again, defensively, from the test-side DB wrapper (support/testDb.ts).
 *
 * Deny-key is the Supabase project ref, NOT the hostname. Supabase's pooler
 * (aws-<n>-<region>.pooler.supabase.com) is shared regional infrastructure —
 * every project in the same region resolves to the same host. The project is
 * identified only by the connection username (postgres.<ref>) in pooler URLs,
 * or by the host itself in the older direct-connection shape (db.<ref>.supabase.co).
 * A host-only comparison would false-positive on any same-region test project.
 *
 * Three layers, checked in order, any one of which trips the fence:
 *   (0) Raw substring guard — runs before any parsing. Catches the prod
 *       project ref appearing ANYWHERE in the string (e.g. in a path/dbname
 *       segment), including shapes checks (a)/(b) below don't recognize.
 *   (a) Parsed project ref equals DATABASE_URL's parsed project ref, when
 *       DATABASE_URL is present in the environment.
 *   (b) Parsed project ref equals the hardcoded PROD_PROJECT_REF constant.
 */

// Confirmed 8 Jul via `.env` DATABASE_URL (host/ref only — never the password).
// Exported so other test-side modules (e.g. the fence-rider canary) have a
// single source of truth instead of re-hardcoding the literal.
export const PROD_PROJECT_REF = "mgkqvrkalrdnvrvfjdus";

interface ConnectionInfo {
  projectRef: string | null;
}

// Throws on an unparseable connection string — callers must treat that as
// fail-closed (cannot prove safety), never as "no match, assume fine."
function parseConnectionInfo(connectionString: string): ConnectionInfo {
  const url = new URL(connectionString);

  const poolerMatch = /^postgres\.([a-z0-9]+)$/i.exec(url.username);
  if (poolerMatch) return { projectRef: poolerMatch[1] };

  const directMatch = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(url.hostname);
  if (directMatch) return { projectRef: directMatch[1] };

  return { projectRef: null };
}

export function assertTestDatabaseSafe(): void {
  const testUrl = process.env.TEST_DATABASE_URL;

  // Invariant: no fallback, no ||, no default. Unset → loud, named refusal,
  // before any DB connection is opened.
  if (!testUrl) {
    throw new Error("FENCE: TEST_DATABASE_URL is not set — refusing to run tests");
  }

  // Check (0): raw substring guard, before any parsing. Catches the prod ref
  // appearing anywhere in the string, even outside the two URL shapes checks
  // (a)/(b) below know how to parse (e.g. tucked into a path/dbname segment).
  if (testUrl.includes(PROD_PROJECT_REF)) {
    throw new Error("FENCE: TEST_DATABASE_URL points at the production database — refusing to run tests");
  }

  let testInfo: ConnectionInfo;
  try {
    testInfo = parseConnectionInfo(testUrl);
  } catch {
    // Fail closed: an unparseable TEST_DATABASE_URL cannot be proven safe.
    throw new Error("FENCE: TEST_DATABASE_URL could not be parsed — refusing to run tests");
  }

  // Deny check (b): hardcoded prod project ref.
  if (testInfo.projectRef !== null && testInfo.projectRef === PROD_PROJECT_REF) {
    throw new Error("FENCE: TEST_DATABASE_URL points at the production database — refusing to run tests");
  }

  // Deny check (a): same project ref as DATABASE_URL, when DATABASE_URL is present.
  const prodUrl = process.env.DATABASE_URL;
  if (!prodUrl) return;

  // Rider-aware short-circuit: the fence rider (tests/setupWorker.ts)
  // reassigns process.env.DATABASE_URL = process.env.TEST_DATABASE_URL, per
  // worker, before any test file's own imports run. Every re-assertion of this
  // function AFTER that point (tests/support/testDb.ts, tests/schema.test.ts)
  // therefore sees DATABASE_URL already equal to TEST_DATABASE_URL — that
  // exact-string identity is the rider's own doing, not a real prod pointer.
  // Layers 0 and (b) above have already proven testUrl is not prod; identity
  // with a proven-non-prod value is benign. Layer (a) below still exists to
  // catch a genuinely DISTINCT DATABASE_URL that happens to share prod's ref.
  if (prodUrl === testUrl) return;

  let prodInfo: ConnectionInfo;
  try {
    prodInfo = parseConnectionInfo(prodUrl);
  } catch {
    // Fail closed: DATABASE_URL is present but we can't parse it, so we can't
    // prove TEST_DATABASE_URL is a different database — refuse rather than guess.
    throw new Error("FENCE: DATABASE_URL is set but could not be parsed — refusing to run tests");
  }

  // Fail closed: if either side has no extractable project ref, never assume
  // "no ref" means "different database" — fall back to comparing the full
  // connection strings instead of silently passing.
  const sameDatabase =
    testInfo.projectRef !== null && prodInfo.projectRef !== null
      ? testInfo.projectRef === prodInfo.projectRef
      : testUrl === prodUrl;

  if (sameDatabase) {
    // Deliberately distinct from layer (0)/(b)'s "points at the production
    // database" message: this is DATABASE_URL sharing TEST_DATABASE_URL's
    // resolved ref while being a DIFFERENT string — not necessarily prod
    // itself, but not provably different from it either. Conflating the two
    // messages was itself part of the original bug (misdiagnosis-bait).
    throw new Error(
      "FENCE: TEST_DATABASE_URL resolves to the same database as DATABASE_URL — refusing to run tests",
    );
  }
}
