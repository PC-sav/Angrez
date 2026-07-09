/**
 * tests/globalSetup.ts
 *
 * Vitest globalSetup — runs once, in an isolated context, BEFORE any test file
 * is collected or loaded. If assertTestDatabaseSafe() throws, the entire run
 * aborts here: zero test files load, zero DB connections are attempted. This
 * is the earliest possible hook and the primary enforcement point for the
 * test fence (see tests/support/fence.ts).
 */

import "dotenv/config";
import { assertTestDatabaseSafe } from "./support/fence";

export default function setup(): void {
  assertTestDatabaseSafe();
}
