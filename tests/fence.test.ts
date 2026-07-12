/**
 * tests/fence.test.ts
 *
 * G3 — unit tests for assertTestDatabaseSafe() itself. These run WITHOUT any
 * DB connection (the function is a pure function of process.env), so they
 * can't be fenced out by their own fence: by the time this file executes,
 * globalSetup has already validated the AMBIENT TEST_DATABASE_URL is safe;
 * these tests exercise the function's branches against STUBBED env values via
 * vi.stubEnv, never the ambient ones, and never open a real connection.
 *
 * Covers all three layers (see tests/support/fence.ts header):
 *   (0) raw substring guard (pre-parse), (a) same project ref as DATABASE_URL,
 *   (b) hardcoded prod project ref — plus unset and fail-closed-parsing cases.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { assertTestDatabaseSafe } from "./support/fence";

const PROD_POOLER_URL = "postgresql://postgres.mgkqvrkalrdnvrvfjdus:secret@aws-1-ap-south-1.pooler.supabase.com:5432/postgres";
const PROD_DIRECT_URL = "postgresql://postgres:secret@db.mgkqvrkalrdnvrvfjdus.supabase.co:5432/postgres";
const FOREIGN_POOLER_URL = "postgresql://postgres.someotherprojectref:secret@aws-1-ap-south-1.pooler.supabase.com:5432/postgres";
// Same ref as FOREIGN_POOLER_URL ("someotherprojectref") via the OTHER
// recognized shape (direct-connection) — a genuinely distinct string, not
// the rider's exact-identity case.
const FOREIGN_DIRECT_URL_SAME_REF = "postgresql://postgres:different-secret@db.someotherprojectref.supabase.co:5432/postgres";
const LOCAL_URL = "postgresql://testuser:testpass@localhost:5432/angrez_test";
const PROD_REF_OUTSIDE_RECOGNIZED_SHAPES_URL = "postgresql://user:pass@somehost:5432/mgkqvrkalrdnvrvfjdus";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("assertTestDatabaseSafe — unset", () => {
  it("throws the named FENCE error when TEST_DATABASE_URL is unset", () => {
    vi.stubEnv("TEST_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    expect(() => assertTestDatabaseSafe()).toThrow(
      "FENCE: TEST_DATABASE_URL is not set — refusing to run tests",
    );
  });
});

describe("assertTestDatabaseSafe — check (0): raw substring guard", () => {
  it("throws when the prod ref appears outside both recognized URL shapes (e.g. in the path/dbname)", () => {
    // Regression test: parseConnectionInfo only recognizes the pooler
    // (postgres.<ref> username) and direct-connection (db.<ref>.supabase.co
    // host) shapes. This URL puts the prod ref in the dbname/path instead —
    // neither shape matches, so testInfo.projectRef would parse as null and
    // checks (a)/(b) alone would let it through. Check (0)'s raw substring
    // test must catch it before parsing ever runs.
    vi.stubEnv("TEST_DATABASE_URL", PROD_REF_OUTSIDE_RECOGNIZED_SHAPES_URL);
    vi.stubEnv("DATABASE_URL", "");
    expect(() => assertTestDatabaseSafe()).toThrow(
      "FENCE: TEST_DATABASE_URL points at the production database — refusing to run tests",
    );
  });
});

describe("assertTestDatabaseSafe — deny check (b): hardcoded prod project ref", () => {
  it("throws when TEST_DATABASE_URL is the prod pooler URL", () => {
    vi.stubEnv("TEST_DATABASE_URL", PROD_POOLER_URL);
    vi.stubEnv("DATABASE_URL", "");
    expect(() => assertTestDatabaseSafe()).toThrow(
      "FENCE: TEST_DATABASE_URL points at the production database — refusing to run tests",
    );
  });

  it("throws when TEST_DATABASE_URL is the prod direct-connection URL (db.<ref>.supabase.co shape)", () => {
    vi.stubEnv("TEST_DATABASE_URL", PROD_DIRECT_URL);
    vi.stubEnv("DATABASE_URL", "");
    expect(() => assertTestDatabaseSafe()).toThrow(
      "FENCE: TEST_DATABASE_URL points at the production database — refusing to run tests",
    );
  });

  it("does NOT trip on host alone — a different project on the SAME shared pooler host passes", () => {
    // Regression guard for the host-vs-project-ref finding: same regional
    // pooler hostname, different project ref, must be allowed through.
    vi.stubEnv("TEST_DATABASE_URL", FOREIGN_POOLER_URL);
    vi.stubEnv("DATABASE_URL", "");
    expect(() => assertTestDatabaseSafe()).not.toThrow();
  });
});

describe("assertTestDatabaseSafe — deny check (a): same project ref as DATABASE_URL", () => {
  it("throws when TEST_DATABASE_URL and DATABASE_URL resolve to the same project ref", () => {
    vi.stubEnv("TEST_DATABASE_URL", PROD_POOLER_URL);
    vi.stubEnv("DATABASE_URL", PROD_POOLER_URL);
    expect(() => assertTestDatabaseSafe()).toThrow(
      "FENCE: TEST_DATABASE_URL points at the production database — refusing to run tests",
    );
  });

  it("passes when DATABASE_URL is present but resolves to a different project ref", () => {
    vi.stubEnv("TEST_DATABASE_URL", FOREIGN_POOLER_URL);
    vi.stubEnv("DATABASE_URL", PROD_POOLER_URL);
    expect(() => assertTestDatabaseSafe()).not.toThrow();
  });

  it("is skipped entirely when DATABASE_URL is not present in the environment", () => {
    vi.stubEnv("TEST_DATABASE_URL", LOCAL_URL);
    vi.stubEnv("DATABASE_URL", "");
    expect(() => assertTestDatabaseSafe()).not.toThrow();
  });
});

describe("assertTestDatabaseSafe — rider-aware layer (a): exact-string identity with DATABASE_URL", () => {
  // Regression coverage for the fence-rider false positive (12 Jul): the rider
  // (tests/setupWorker.ts) reassigns process.env.DATABASE_URL =
  // process.env.TEST_DATABASE_URL per worker, so every post-reassignment
  // re-assertion (tests/support/testDb.ts, tests/schema.test.ts) sees the two
  // vars as the IDENTICAL string. That identity is the rider's own doing, not
  // a real prod pointer, and must not trip the fence on its own.

  it("passes when TEST_DATABASE_URL and DATABASE_URL are the IDENTICAL non-prod string (the rider's own post-reassignment state)", () => {
    vi.stubEnv("TEST_DATABASE_URL", FOREIGN_POOLER_URL);
    vi.stubEnv("DATABASE_URL", FOREIGN_POOLER_URL);
    expect(() => assertTestDatabaseSafe()).not.toThrow();
  });

  it("still refuses when TEST_DATABASE_URL and DATABASE_URL are DISTINCT strings that resolve to the same non-prod ref", () => {
    vi.stubEnv("TEST_DATABASE_URL", FOREIGN_POOLER_URL);
    vi.stubEnv("DATABASE_URL", FOREIGN_DIRECT_URL_SAME_REF);
    expect(() => assertTestDatabaseSafe()).toThrow(
      "FENCE: TEST_DATABASE_URL resolves to the same database as DATABASE_URL — refusing to run tests",
    );
  });

  it("still refuses a prod-ref TEST_DATABASE_URL even when DATABASE_URL is the IDENTICAL string — layers 0/(b) fire before the identity short-circuit", () => {
    vi.stubEnv("TEST_DATABASE_URL", PROD_REF_OUTSIDE_RECOGNIZED_SHAPES_URL);
    vi.stubEnv("DATABASE_URL", PROD_REF_OUTSIDE_RECOGNIZED_SHAPES_URL);
    expect(() => assertTestDatabaseSafe()).toThrow(
      "FENCE: TEST_DATABASE_URL points at the production database — refusing to run tests",
    );
  });
});

describe("assertTestDatabaseSafe — clean foreign host", () => {
  it("passes for a local Postgres URL with no DATABASE_URL set", () => {
    vi.stubEnv("TEST_DATABASE_URL", LOCAL_URL);
    vi.stubEnv("DATABASE_URL", "");
    expect(() => assertTestDatabaseSafe()).not.toThrow();
  });

  it("passes for a local Postgres URL even when DATABASE_URL points at prod", () => {
    vi.stubEnv("TEST_DATABASE_URL", LOCAL_URL);
    vi.stubEnv("DATABASE_URL", PROD_POOLER_URL);
    expect(() => assertTestDatabaseSafe()).not.toThrow();
  });
});

describe("assertTestDatabaseSafe — fail-closed parsing", () => {
  it("refuses when TEST_DATABASE_URL is set but unparseable as a URL", () => {
    vi.stubEnv("TEST_DATABASE_URL", "not-a-valid-url");
    vi.stubEnv("DATABASE_URL", "");
    expect(() => assertTestDatabaseSafe()).toThrow(
      "FENCE: TEST_DATABASE_URL could not be parsed — refusing to run tests",
    );
  });

  it("refuses when DATABASE_URL is present but unparseable — cannot prove TEST_DATABASE_URL differs", () => {
    vi.stubEnv("TEST_DATABASE_URL", LOCAL_URL);
    vi.stubEnv("DATABASE_URL", "not-a-valid-url");
    expect(() => assertTestDatabaseSafe()).toThrow(
      "FENCE: DATABASE_URL is set but could not be parsed — refusing to run tests",
    );
  });
});
