/**
 * tests/fence_rider.test.ts
 *
 * Canary for the fence rider (tests/setupWorker.ts). Imports the SERVER pool
 * module directly (src/lib/db.ts) — the same module src/app.ts's routes use —
 * and asserts its resolved connection string is the test DB, never prod.
 *
 * Reads pool.options.connectionString only; never calls .query()/.connect(),
 * so this needs no live DB — G1 passes with any syntactically valid,
 * fence-passing TEST_DATABASE_URL.
 *
 * REDACTION RULE: every assertion here compares to a boolean, never to the
 * raw connection string. A direct `expect(resolvedConnectionString).toBe(x)`
 * renders BOTH values (received + expected) in the failure diff — which is
 * exactly how a live G2 check of this canary printed the real prod connection
 * string, password included, into a terminal/session transcript. Reducing
 * each comparison to a boolean before it ever reaches expect() means a
 * failure can only ever show `true`/`false` plus a plain description string,
 * never the secret.
 *
 * Fails meaningfully in both failure modes:
 *   - override missing entirely → DATABASE_URL is still the real prod value
 *     → containsProdRef is true → second assertion fails.
 *   - override present but mis-ordered (e.g. src/config/env.ts got imported,
 *     and its databaseUrl cached, before setupWorker.ts's reassignment ran)
 *     → connectionString is the ORIGINAL DATABASE_URL, not TEST_DATABASE_URL
 *     → matchesTestUrl is false → last assertion fails.
 */

import { describe, it, expect } from "vitest";
import pool from "../src/lib/db";
import { PROD_PROJECT_REF } from "./support/fence";

describe("fence rider — server pool binds to TEST_DATABASE_URL inside test workers", () => {
  it("src/lib/db.ts's resolved connection string is never prod, and matches TEST_DATABASE_URL", () => {
    const resolvedConnectionString = (pool as unknown as { options: { connectionString?: string } })
      .options.connectionString;

    const isTruthy = Boolean(resolvedConnectionString);
    expect(isTruthy, "server pool has no resolved connectionString").toBe(true);

    const containsProdRef = (resolvedConnectionString as string).includes(PROD_PROJECT_REF);
    expect(containsProdRef, "server pool resolved to PROD — rider override missing").toBe(false);

    const testUrlPresent = Boolean(process.env.TEST_DATABASE_URL);
    expect(testUrlPresent, "TEST_DATABASE_URL missing in worker").toBe(true);

    const matchesTestUrl = resolvedConnectionString === process.env.TEST_DATABASE_URL;
    expect(matchesTestUrl, "server pool != TEST_DATABASE_URL — override mis-ordered (env.ts imported first?)").toBe(true);
  });
});
