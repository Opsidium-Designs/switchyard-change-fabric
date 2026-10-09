import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One private temp root per run (TMPDIR), removed at the end: tests never
    // leave work directories behind in the system temp directory.
    globalSetup: [fileURLToPath(new URL("../../tools/vitest-temp-root.ts", import.meta.url))],
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The integration test does real git clone/commit/push over file:// remotes
    // and runs the demo project's test command, which can exceed the default
    // timeout on a cold cache.
    testTimeout: 60000,
  },
});
