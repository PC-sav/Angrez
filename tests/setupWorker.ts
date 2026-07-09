/**
 * tests/setupWorker.ts
 *
 * FENCE RIDER — runs once per test worker, wired via vitest.config.ts's
 * `setupFiles`, BEFORE any test file's own imports execute. Verified from
 * @vitest/runner's source (node_modules/@vitest/runner/dist/index.js,
 * collectTests()): setupFiles are awaited to completion, THEN the test file
 * itself is imported ("collect" phase) — for every file, so this reassignment
 * is in effect before the first file in a worker ever imports anything.
 *
 * Why this exists (not covered by the original fence block): src/app.ts's
 * routes write through the server's own pool (src/lib/db.ts → DATABASE_URL),
 * a DIFFERENT pg.Pool instance from the test-fenced one (tests/support/testDb.ts).
 * Once a real TEST_DATABASE_URL exists, any supertest-driven HTTP test would
 * still exercise route handlers against whatever DATABASE_URL resolves to —
 * i.e. prod, locally. Reassigning process.env.DATABASE_URL here, before
 * src/config/env.ts is ever imported in this worker (env.ts reads
 * process.env.DATABASE_URL exactly once, at import time, and caches it — so
 * order is load-bearing), means src/lib/db.ts's pool binds to the test
 * database instead. src/lib/db.ts itself is untouched: invariant 4 of the
 * original fence block still holds — the server module stays env-dumb.
 *
 * globalSetup.ts already validated TEST_DATABASE_URL once for the whole run,
 * but globalSetup runs in a separate, isolated context (the main Vitest
 * orchestrator process) whose process.env mutations do NOT propagate to test
 * workers — confirmed: no SHARE_ENV mechanism exists anywhere in vitest or
 * tinypool; forked/threaded workers receive an explicit env SNAPSHOT at pool
 * creation, not a live reference. So the fence is re-asserted here, per
 * worker, before the reassignment below — defense in depth, not redundant.
 */

import "dotenv/config";
import { assertTestDatabaseSafe } from "./support/fence";

assertTestDatabaseSafe();

// Must run AFTER assertTestDatabaseSafe() — that check compares
// TEST_DATABASE_URL against the REAL DATABASE_URL; reassigning first would
// make the comparison meaningless (both sides identical, always "same").
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
