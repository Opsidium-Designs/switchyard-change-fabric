import { defineConfig } from "vitest/config";

// The console's offline tests are PURE: the pan/zoom interaction logic is plain
// functions, and the node-shape rendering is checked with react-dom/server's
// renderToStaticMarkup (no browser, no jsdom). So the node environment is enough
// and `make check` stays offline and deterministic.
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
  },
});
