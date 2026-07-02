import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

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
  ],
});
