import {
  QueryClient,
  defaultShouldDehydrateQuery,
} from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";
import { getSession, subscribeSession } from "./auth";
import { stableAttachmentStructuralSharing } from "./stableAttachmentUrls";

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
//
// `structuralSharing` keeps an attachment's presigned URL stable across
// refetches (the backend re-signs it on every read) so a background refetch
// doesn't swap the `src` of every image/video/audio already on screen —
// see lib/stableAttachmentUrls.ts.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      networkMode: "online",
      gcTime: typeof window === "undefined" ? Infinity : PERSIST_MAX_AGE_MS,
      structuralSharing: stableAttachmentStructuralSharing,
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
//
// The snapshot is private to whoever fetched it (their chats, their view of
// the feed), but query keys aren't scoped per user — so it's stored under a
// per-user key, resolved at the moment of each read/write, and nothing is
// persisted while signed out. That alone isn't enough: the *in-memory*
// cache would still hold the previous account's data (and the throttled
// writer would carry it into the next user's slot), so `watchCacheOwner`
// below also clears the client the instant the signed-in user changes, and
// deletes the previous user's snapshot (issue #478).
const PERSIST_KEY_PREFIX = "chat-platform-query-cache";

function currentUserId(): number | null {
  return getSession()?.user.id ?? null;
}

function persistKeyFor(userId: number): string {
  return `${PERSIST_KEY_PREFIX}:${userId}`;
}

// A `Storage`-shaped wrapper that ignores the persister's own (fixed) key
// and substitutes the signed-in user's.
const userScopedStorage = {
  getItem: () => {
    const userId = currentUserId();
    return userId === null
      ? null
      : window.localStorage.getItem(persistKeyFor(userId));
  },
  setItem: (_key: string, value: string) => {
    const userId = currentUserId();
    if (userId !== null)
      window.localStorage.setItem(persistKeyFor(userId), value);
  },
  removeItem: () => {
    const userId = currentUserId();
    if (userId !== null) window.localStorage.removeItem(persistKeyFor(userId));
  },
};

// Clears everything cached for the previous account the moment the session
// switches to a different user (or to none): logout in this or another tab,
// an expired refresh token, or logging in as someone else. Synchronous with
// the session change, so the throttled persister's pending write — which
// always saves the *latest* snapshot — can only ever save the cleared one.
// Token refreshes keep the same user id and leave the cache alone.
function watchCacheOwner(): void {
  // The single shared slot used before snapshots were scoped per user.
  window.localStorage.removeItem(PERSIST_KEY_PREFIX);
  let owner = currentUserId();
  subscribeSession(() => {
    const next = currentUserId();
    if (next === owner) return;
    if (owner !== null) window.localStorage.removeItem(persistKeyFor(owner));
    owner = next;
    queryClient.clear();
  });
}

if (typeof window !== "undefined") watchCacheOwner();

export const persistOptions: PersistQueryClientOptions = {
  queryClient,
  persister: createSyncStoragePersister({
    storage: typeof window !== "undefined" ? userScopedStorage : undefined,
    key: PERSIST_KEY_PREFIX,
  }),
  maxAge: PERSIST_MAX_AGE_MS,
  // Overriding `shouldDehydrateQuery` replaces React Query's default check
  // that a query has actually loaded, so it has to be kept explicitly: a
  // still-pending query is dehydrated together with its in-flight promise,
  // which logs "dehydrated as pending ended up rejecting" whenever that
  // fetch is later cancelled, and — since a promise doesn't survive JSON —
  // makes the next restore throw and discard the whole snapshot (#501).
  dehydrateOptions: {
    shouldDehydrateQuery: (query) =>
      defaultShouldDehydrateQuery(query) && isPersistedQueryKey(query.queryKey),
  },
};
