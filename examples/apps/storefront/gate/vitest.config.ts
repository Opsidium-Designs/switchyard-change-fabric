import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The acceptance gate's own runner config: it runs ONLY the goal-level
// acceptance suite under gate/. The developer suite under tests/ keeps the root
// vitest.config.ts; `npm run gate` runs both.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: ["gate/**/*.test.ts"],
    environment: "node",
  },
});
