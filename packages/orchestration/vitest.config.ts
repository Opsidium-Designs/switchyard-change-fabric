import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One private temp root per run (TMPDIR), removed at the end: tests never
    // leave work directories behind in the system temp directory.
    globalSetup: [fileURLToPath(new URL("../../tools/vitest-temp-root.ts", import.meta.url))],
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The end-to-end demo test runs the whole pipeline (real git clone, commit,
    // and push over file:// remotes through verification, integration, and
    // promotion), which can exceed the default timeout on a cold cache.
    testTimeout: 120000,
  },
});
