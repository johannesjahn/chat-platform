import { readFileSync, writeFileSync } from "node:fs";
import type { Plugin } from "vite";
import type { VitePWAOptions } from "vite-plugin-pwa";

// The lazy routes whose chunks the service worker doesn't precache (issue
// #755): the games and the admin dashboard. Both are useless offline (lobbies
// and stats are live data) and most users never open them, yet precaching
// made every first visit download them in the background. They're cached the
// first time they actually load instead (see `runtimeCaching` below).
const OPTIONAL_ROUTE = /\/src\/routes\/(?:games\/|admin\.tsx)/;

// The client build writes the list of those chunks here and the PWA build
// reads it back when it generates sw.js. Outside dist/client, so it isn't
// deployed.
const OPTIONAL_CHUNKS_FILE = new URL(
  "./dist/pwa-optional-chunks.json",
  import.meta.url,
);

/**
 * Records which client chunks are reachable *only* through an optional
 * route's lazy import: whatever is left after walking the chunk graph from
 * the entry and every other dynamic import. A chunk an optional route shares
 * with a core one (an icon, the game stats on a profile) is reachable from
 * the core one, so it stays precached. Runs in the main build
 * (vite.config.ts), since the separate PWA build never sees the chunk graph.
 */
export function optionalChunksPlugin(): Plugin {
  return {
    name: "pwa-optional-chunks",
    apply: "build",
    generateBundle(_options, bundle) {
      if (this.environment.name !== "client") return;
      const chunks = new Map(
        Object.values(bundle).flatMap((file) =>
          file.type === "chunk" ? [[file.fileName, file] as const] : [],
        ),
      );
      const isOptional = (fileName: string) => {
        const id = chunks.get(fileName)?.facadeModuleId?.split("?")[0];
        return !!id && OPTIONAL_ROUTE.test(id);
      };
      const reachable = new Set<string>();
      const pending = [...chunks.values()]
        .filter(
          (chunk) =>
            chunk.isEntry ||
            (chunk.isDynamicEntry && !isOptional(chunk.fileName)),
        )
        .map((chunk) => chunk.fileName);
      while (pending.length) {
        const fileName = pending.pop()!;
        if (reachable.has(fileName)) continue;
        reachable.add(fileName);
        const chunk = chunks.get(fileName);
        if (!chunk) continue;
        pending.push(
          ...chunk.imports,
          ...chunk.dynamicImports.filter((f) => !isOptional(f)),
        );
      }
      const optional = [...chunks.keys()].filter((f) => !reachable.has(f));
      // Fail loudly rather than quietly precaching everything again.
      if (!optional.some(isOptional)) {
        this.error(
          `No chunk matched ${OPTIONAL_ROUTE}: did the games/admin routes move?`,
        );
      }
      writeFileSync(OPTIONAL_CHUNKS_FILE, JSON.stringify(optional.sort()));
    },
  };
}

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
    theme_color: "#081221",
    background_color: "#081221",
    display: "standalone",
    start_url: "/",
    scope: "/",
    // Not precached: the browser fetches these itself when it installs the
    // app. (favicon-192x192.png is also the apple-touch-icon and the
    // notification icon, neither of which matters offline.)
    icons: [
      { src: "/favicon-192x192.png", sizes: "192x192", type: "image/png" },
      { src: "/favicon-512x512.png", sizes: "512x512", type: "image/png" },
    ],
  },
  workbox: {
    navigateFallback: "/index.html",
    // A real file, not an app route: don't answer a navigation to it with
    // the cached shell (issue #706).
    navigateFallbackDenylist: [/^\/robots\.txt$/],
    // The shell's code, styles and HTML, and only the images it shows
    // itself: the tab icon and the one `useTabBadge` (lib/tabBadge.ts)
    // paints the unread dot onto, which has to load offline too (issue #755).
    globPatterns: [
      "**/*.{js,css,html,webmanifest}",
      "favicon.ico",
      "favicon-32x32.png",
    ],
    manifestTransforms: [
      (entries) => {
        const optional = new Set(
          JSON.parse(readFileSync(OPTIONAL_CHUNKS_FILE, "utf8")) as string[],
        );
        return {
          manifest: entries.filter((entry) => !optional.has(entry.url)),
        };
      },
    ],
    // What isn't precached (the optional chunks above) is cached the first
    // time it loads, so a game opened once still opens offline. Every
    // /assets/ file is content-hashed, so a cached copy is never stale and
    // the network is only asked on a miss. Precached URLs never get here:
    // the precache route answers them first.
    runtimeCaching: [
      {
        urlPattern: ({ url, sameOrigin }) =>
          sameOrigin && url.pathname.startsWith("/assets/"),
        handler: "CacheFirst",
        options: {
          cacheName: "lazy-chunks",
          expiration: {
            maxEntries: 100,
            maxAgeSeconds: 60 * 60 * 24 * 30,
            purgeOnQuotaError: true,
          },
          cacheableResponse: { statuses: [200] },
        },
      },
    ],
  },
};
