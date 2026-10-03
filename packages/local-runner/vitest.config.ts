import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The concurrent-runners test does real git clone/commit/push over file://
    // remotes, which can take longer than the default timeout on a cold cache.
    testTimeout: 30000,
  },
});
