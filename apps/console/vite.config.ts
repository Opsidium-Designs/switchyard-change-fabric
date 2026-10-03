import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The console is the single-page visual demo surface for the Change Fabric.
// It runs on its own Vite dev server; the Worker control API runs separately
// under `wrangler dev`. Real Change/WorkUnit wiring arrives in later milestones.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
});
