import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The end-to-end demo test runs the whole pipeline (real git clone, commit,
    // and push over file:// remotes through verification, integration, and
    // promotion), which can exceed the default timeout on a cold cache.
    testTimeout: 60000,
  },
});
