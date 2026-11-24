import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { optionalChunksPlugin, sharedPwaOptions } from "./vite.pwa-options.ts";

const FRAMEWORK_MODULES =
  /node_modules\/(?:react|react-dom|scheduler|use-sync-external-store|@tanstack\/(?:react-router|router-core|history|store|react-store|react-query|query-core))\//;

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: {
            // Every page needs all of this before it hydrates. As one chunk
            // it gzips smaller than the dozen slivers automatic splitting
            // makes of it (issue #754), and an app-only deploy leaves it
            // cached.
            codeSplitting: {
              groups: [{ name: "framework", test: FRAMEWORK_MODULES }],
            },
          },
        },
      },
    },
  },
  plugins: [
    tailwindcss(),
    // SPA mode: no SSR server. Build emits a static index.html shell + assets;
    // all data is fetched client-side from the backend API.
    tanstackStart({
      spa: { enabled: true, prerender: { outputPath: "/index.html" } },
    }), // MUST come before react()
    viteReact(),
    // This instance exists only so app code can resolve/bundle the
    // `virtual:pwa-register` module (used by src/lib/pwa.ts). Its own
    // asset/service-worker generation never actually runs here: TanStack
    // Start's build uses Vite's multi-environment builder (client + ssr),
    // and vite-plugin-pwa's closeBundle hook doesn't support that — see
    // https://github.com/TanStack/router/issues/4988. The real sw.js and
    // manifest.webmanifest are produced by a separate, isolated build —
    // see vite.pwa.config.ts, run as part of `bun run build`.
    VitePWA(sharedPwaOptions),
    // Tells that separate build which lazy chunks to leave out of the
    // precache (issue #755) — only this build sees the chunk graph.
    optionalChunksPlugin(),
  ],
});
