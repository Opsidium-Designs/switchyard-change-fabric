import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The Worker's offline tests drive the REAL request handler and the REAL
// ChangeState Durable Object class in-process. The only runtime piece Node
// cannot resolve is the `cloudflare:workers` module the DO extends, so it is
// aliased to a tiny stub that supplies the DurableObject base (ctx + env). The
// tests inject an in-memory storage and a fake namespace; no network is used,
// so `make check` stays offline and deterministic.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./tests/cloudflare-workers-stub.ts", import.meta.url)),
    },
  },
  test: {
    // One private temp root per run (TMPDIR), removed at the end: tests never
    // leave work directories behind in the system temp directory.
    globalSetup: [fileURLToPath(new URL("../../tools/vitest-temp-root.ts", import.meta.url))],
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
