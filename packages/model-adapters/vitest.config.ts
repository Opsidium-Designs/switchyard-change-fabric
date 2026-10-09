import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One private temp root per run (TMPDIR), removed at the end: tests never
    // leave work directories behind in the system temp directory.
    globalSetup: [fileURLToPath(new URL("../../tools/vitest-temp-root.ts", import.meta.url))],
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
