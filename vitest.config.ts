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
  },
});
