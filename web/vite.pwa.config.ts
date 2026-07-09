import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { sharedPwaOptions } from "./vite.pwa-options";

const NOOP_ENTRY = "virtual:pwa-noop-entry";

// Standalone build that generates sw.js + manifest.webmanifest into the
// already-built dist/client — see vite.config.ts for why this can't happen
// as part of the main TanStack Start build. Run after `vite build` via
// `bun run build`. Needs a real Rollup entry to trigger the plugin's build
// lifecycle; the noop entry plugin below supplies one without writing
// anything into dist/client (its build.outDir is a scratch directory, kept
// separate from `outDir` in sharedPwaOptions below, which is what
// vite-plugin-pwa actually reads/writes assets from).
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "node_modules/.pwa-build",
    rollupOptions: { input: NOOP_ENTRY },
  },
  plugins: [
    {
      name: "pwa-noop-entry",
      resolveId(id) {
        if (id === NOOP_ENTRY) return id;
      },
      load(id) {
        if (id === NOOP_ENTRY) return "export {};";
      },
    },
    VitePWA({ ...sharedPwaOptions, outDir: "dist/client" }),
  ],
});
