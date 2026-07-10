import { QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";

// How long a persisted cache entry may sit in storage before the persister
// refuses to restore it (`maxAge` below) — also drives `gcTime`, since a
// query garbage-collected from memory before that point can never make it
// into the persisted snapshot in the first place (React Query only
// persists what's still in the in-memory cache at the time it writes).
const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Single client for the SPA. Retries off keeps auth/validation errors (401/409)
// surfacing immediately instead of being retried. `networkMode: "online"`
// (React Query's default, spelled out here so it isn't accidentally changed)
// means a query with no network connection just sits `fetchStatus: "paused"`
// instead of erroring — the already-rendered/persisted data stays on screen
// rather than being replaced by an error state.
//
// `gcTime` must stay `Infinity` on the server: that's React Query's own
// built-in default there (see `Removable.updateGcTime` in
// @tanstack/query-core), specifically because it's the one `gcTime` value
// `isValidTimeout` treats as "don't schedule a gc timer" at all. Any other
// finite value — including this one, bumped for the client so persisted
// queries survive long enough to actually get persisted — schedules a real,
// unref'd-nothing `setTimeout`, and during this app's SPA prerender
// (`vite.config.ts`'s `tanstackStart({ spa: { prerender: ... } })`) that
// timer is created on the Node.js side while rendering "/", which then
// keeps the build process alive (didn't exit, near-zero CPU) until the
// timer fires — 24h later — instead of at the end of the build. Overriding
// it unconditionally is exactly what caused that hang; matching React
// Query's own server-vs-client branch here avoids it.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      networkMode: "online",
      gcTime: typeof window === "undefined" ? Infinity : PERSIST_MAX_AGE_MS,
    },
  },
});

// Only chats/posts reads are safe (and useful) to persist across reloads —
// this deliberately excludes one-off lookups like user search
// (`["get", "/users/search", ...]`) that shouldn't survive past the session
// they were fetched in. Matches the "read-only offline for already-loaded
// data" first slice from issue #145; write-side offline queueing is a
// separate follow-up.
const PERSISTED_QUERY_KEY_PREFIXES = ["chats", "posts"];

function isPersistedQueryKey(queryKey: readonly unknown[]): boolean {
  return PERSISTED_QUERY_KEY_PREFIXES.includes(queryKey[0] as string);
}

// localStorage (via the sync persister) rather than IndexedDB: chat/post
// pages are capped (see MESSAGES_MAX_LIMIT, INITIAL_POSTS_LIMIT) so the
// persisted payload stays well within localStorage's ~5MB budget, and the
// sync persister needs no extra IndexedDB wrapper dependency.
export const persistOptions: PersistQueryClientOptions = {
  queryClient,
  persister: createSyncStoragePersister({
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
    key: "chat-platform-query-cache",
  }),
  maxAge: PERSIST_MAX_AGE_MS,
  dehydrateOptions: {
    shouldDehydrateQuery: (query) => isPersistedQueryKey(query.queryKey),
  },
};
