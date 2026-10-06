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
    // host: true binds 0.0.0.0 so the console is reachable from other machines
    // on the LAN (not only localhost). Harmless locally. Pair it with
    // VITE_WORKER_URL pointing at this host's LAN IP so the browser (and the
    // spawned run) reach the Worker by its LAN address rather than 127.0.0.1.
    host: true,
    port: 5173,
    strictPort: false,
  },
});
