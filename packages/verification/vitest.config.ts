import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The integration test does real git clone/commit/push over file:// remotes
    // and runs the demo project's test command, which can exceed the default
    // timeout on a cold cache.
    testTimeout: 60000,
  },
});
