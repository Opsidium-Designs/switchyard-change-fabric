import { defineConfig } from "vitest/config";

// The developer suite under tests/. The goal-level acceptance suite under gate/
// has its own config (gate/vitest.config.ts); `npm run gate` runs both.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
