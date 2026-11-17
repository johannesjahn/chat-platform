// Recovering a tab that's running a build which is no longer deployed.
//
// Every deploy renames the content-hashed /assets/ files and drops the old
// ones, and the static host answers a missing one with the SPA's index.html
// (200, text/html). A tab still on the previous build — most often an
// installed PWA whose service worker served it the precached old shell —
// then fails the first lazy chunk it hasn't loaded yet, like the games
// routes, which aren't precached (issue #755). A plain reload doesn't help
// while that service worker still controls the page: it serves the same old
// shell, which asks for the same missing chunk. TanStack Router's own
// reload-once in `lazyRouteComponent` ends up exactly there. So this asks the
// service worker to update first, and reloads once the new one has taken over.

// The rejection messages of a dynamic import whose module couldn't be
// fetched or wasn't JavaScript — Chromium, Firefox and Safari in that order
// (the same ones `lazyRouteComponent` reloads for) — plus Vite's when a
// chunk's CSS is missing.
const STALE_CHUNK_MESSAGES = [
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "Unable to preload CSS",
];

export function isStaleChunkError(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return (
    typeof message === "string" &&
    STALE_CHUNK_MESSAGES.some((prefix) => message.startsWith(prefix))
  );
}

// An automatic reload is skipped if one already happened this recently, so
// a chunk that's missing for some other reason shows its error instead of
// reloading forever. A reload the user asks for always goes ahead.
export const RELOAD_COOLDOWN_MS = 60_000;
const RELOADED_AT_KEY = "stale-build-reloaded-at";

// How long to wait for a newer service worker to take over before reloading
// anyway.
export const SW_TAKEOVER_TIMEOUT_MS = 5000;

export type ReloadDeps = {
  storage: Pick<Storage, "getItem" | "setItem">;
  now: () => number;
  // Resolves once the newest service worker controls the page, or there's
  // nothing newer to wait for.
  activateLatestBuild: () => Promise<void>;
  reload: () => void;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function activateLatestServiceWorker(): Promise<void> {
  const container = navigator.serviceWorker as
    ServiceWorkerContainer | undefined;
  if (!container?.controller) return;
  const registration = await container.getRegistration();
  if (!registration) return;
  const tookOver = new Promise<void>((resolve) =>
    container.addEventListener("controllerchange", () => resolve(), {
      once: true,
    }),
  );
  await registration.update().catch(() => {});
  // A worker installing or waiting is the newer build: it skips waiting and
  // claims this page (`autoUpdate`, see vite.pwa-options.ts).
  if (registration.installing || registration.waiting)
    await Promise.race([tookOver, sleep(SW_TAKEOVER_TIMEOUT_MS)]);
}

function browserDeps(): ReloadDeps {
  return {
    storage: window.sessionStorage,
    now: Date.now,
    activateLatestBuild: activateLatestServiceWorker,
    reload: () => window.location.reload(),
  };
}

function reloadedRecently({ storage, now }: ReloadDeps): boolean {
  let at: number;
  try {
    at = Number(storage.getItem(RELOADED_AT_KEY));
  } catch {
    // Storage that can't be read can't record a reload either; never
    // reload automatically rather than risk a loop.
    return true;
  }
  return Number.isFinite(at) && at > 0 && now() - at < RELOAD_COOLDOWN_MS;
}

// Whether `reloadIntoLatestBuild` would reload on its own right now.
export function canReloadAutomatically(deps: ReloadDeps = browserDeps()) {
  return !reloadedRecently(deps);
}

// Brings the page onto the newest deployed build and reloads it. Returns
// false, doing nothing, if it's automatic and a reload already happened
// within `RELOAD_COOLDOWN_MS`.
export function reloadIntoLatestBuild(
  { userInitiated = false }: { userInitiated?: boolean } = {},
  deps: ReloadDeps = browserDeps(),
): boolean {
  if (!userInitiated && reloadedRecently(deps)) return false;
  try {
    deps.storage.setItem(RELOADED_AT_KEY, String(deps.now()));
  } catch {
    if (!userInitiated) return false;
  }
  void deps
    .activateLatestBuild()
    .catch(() => {})
    .then(deps.reload);
  return true;
}
