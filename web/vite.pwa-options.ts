import type { VitePWAOptions } from "vite-plugin-pwa";

// Shared between vite.config.ts (needed there only so app code can import
// `virtual:pwa-register`) and vite.pwa.config.ts (which actually generates
// sw.js — see that file for why). registerType "autoUpdate" pairs with
// `usePwaUpdate` in src/lib/pwa.ts immediately activating and reloading on
// `onNeedRefresh` rather than waiting for a manual click — a backend API
// response-shape change can otherwise crash any tab still running an old
// cached bundle against the new API until it happens to reload, so clients
// self-update instead of getting stuck. Keep the two configs' options in
// sync or the registered client and the generated service worker can
// disagree about update behavior.
export const sharedPwaOptions: Partial<VitePWAOptions> = {
  registerType: "autoUpdate",
  injectRegister: false,
  manifest: {
    name: "Chat Platform",
    short_name: "Chat Platform",
    description: "Real-time chat and posts platform",
    theme_color: "#0b0d13",
    background_color: "#0b0d13",
    display: "standalone",
    start_url: "/",
    scope: "/",
    icons: [
      { src: "/favicon-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/favicon-512x512.png", sizes: "512x512", type: "image/png" },
    ],
  },
  workbox: {
    navigateFallback: "/index.html",
    globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
  },
};
