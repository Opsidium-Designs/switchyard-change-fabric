import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { launcherPlugin } from "./launcher";

// The console is the single-page control plane for the Change Fabric. It runs on
// its own Vite dev server; the Worker control API runs separately under
// `wrangler dev`. The launcher plugin adds a dev-only Node-side API the browser
// calls to start and tear down live runs (the console cannot run Git/executors
// itself), so after `make dev-all` a human drives everything from the browser.
export default defineConfig({
  plugins: [react(), launcherPlugin()],
  server: {
    port: 5173,
    strictPort: false,
  },
});
