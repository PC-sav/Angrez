import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: false,
    environment: "node",
    // Test fence — runs once, before any test file is collected/loaded. If it
    // throws, the whole run aborts here: zero test files load, zero DB
    // connections attempted. See tests/globalSetup.ts / tests/support/fence.ts.
    globalSetup: ["./tests/globalSetup.ts"],
    // Fence rider — runs once PER WORKER (globalSetup's env mutations don't
    // propagate to workers), before any test file's own imports. Rebinds the
    // server pool (src/lib/db.ts) to TEST_DATABASE_URL. See tests/setupWorker.ts.
    setupFiles: ["./tests/setupWorker.ts"],
  },
});
