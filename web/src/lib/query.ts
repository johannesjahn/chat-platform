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
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      networkMode: "online",
      gcTime: PERSIST_MAX_AGE_MS,
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
