import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { sharedPwaOptions } from "./vite.pwa-options";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
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
  ],
});
