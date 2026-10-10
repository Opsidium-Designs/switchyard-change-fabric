import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { launcherPlugin } from "./launcher";

// The console is the single-page control plane for the Change Fabric. It runs on
// its own Vite dev server; the Worker control API runs separately under
// `wrangler dev`. The launcher plugin adds a dev-only Node-side API the browser
// calls to start and tear down live runs (the console cannot run Git/executors
// itself), so after `make dev-all` a human drives everything from the browser.
//
// `--mode replay` (or VITE_REPLAY=1) builds the static REPLAY page instead:
// recorded runs from public/replays played back in the browser, with no
// launcher, no Worker, and relative asset paths (base "./") so the output
// works from a subpath or the root. It builds into dist-replay/, which
// wrangler.replay.jsonc serves as static assets.
export default defineConfig(({ mode }) => {
  const replay = mode === "replay" || process.env.VITE_REPLAY === "1";
  return {
    plugins: replay ? [react()] : [react(), launcherPlugin()],
    base: replay ? "./" : "/",
    define: replay ? { "import.meta.env.VITE_REPLAY": JSON.stringify("1") } : {},
    build: replay ? { outDir: "dist-replay", emptyOutDir: true } : {},
    server: {
      // host: true binds 0.0.0.0 so the console is reachable from other machines
      // on the LAN (not only localhost). Harmless locally. Pair it with
      // VITE_WORKER_URL pointing at this host's LAN IP so the browser (and the
      // spawned run) reach the Worker by its LAN address rather than 127.0.0.1.
      host: true,
      port: 5173,
      strictPort: false,
    },
  };
});
