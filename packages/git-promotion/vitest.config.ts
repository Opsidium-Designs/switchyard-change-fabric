import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The promotion test does real git clone/branch/commit over file:// remotes
    // and runs the full coordinate, integrate, promote, and cleanup flow, which
    // can exceed the default timeout on a cold cache.
    testTimeout: 60000,
  },
});
