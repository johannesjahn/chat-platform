import { useSyncExternalStore } from "react";

// Tracks who's currently online, fed by `presence` WS events (see
// realtimeSocket.ts). Deliberately a plain module-level store rather than a
// React Query cache entry: there's no REST resource behind it to refetch —
// the WS connection *is* the source of truth — so a subscribe/notify store
// read via `useSyncExternalStore` is a more honest fit than shoehorning it
// into `queryClient.setQueryData`.
const onlineUserIds = new Set<number>();
const listeners = new Set<() => void>();
// An immutable copy of the set for `useOnlineUserIds`. Built lazily — only
// when something reads it after a change — rather than on every event, so a
// burst of presence frames costs O(1) each instead of a full copy each
// (issue #660).
let snapshot: ReadonlySet<number> = new Set();
let snapshotStale = false;

function notify(): void {
  snapshotStale = true;
  for (const listener of listeners) listener();
}

function getSnapshot(): ReadonlySet<number> {
  if (snapshotStale) {
    snapshot = new Set(onlineUserIds);
    snapshotStale = false;
  }
  return snapshot;
}

// Applies one user's live online/offline transition, pushed after the
// socket's initial snapshot (see `replacePresence`).
export function setUserOnline(userId: number, online: boolean): void {
  const wasOnline = onlineUserIds.has(userId);
  if (wasOnline === online) return;
  if (online) {
    onlineUserIds.add(userId);
  } else {
    onlineUserIds.delete(userId);
  }
  notify();
}

// Replaces all known presence state with a fresh connection's
// `presence_snapshot` — the one frame the server sends right after the
// socket opens, listing which of this user's contacts are online (see
// RealtimeSocket.ts). Doubles as the reset after a reconnect: a dropped
// connection can mean any number of users went offline/online without this
// client hearing about it, so nothing from before survives it.
export function replacePresence(userIds: ReadonlyArray<number>): void {
  if (
    userIds.length === onlineUserIds.size &&
    userIds.every((userId) => onlineUserIds.has(userId))
  ) {
    return;
  }
  onlineUserIds.clear();
  for (const userId of userIds) onlineUserIds.add(userId);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useIsOnline(userId: number | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => userId != null && onlineUserIds.has(userId),
  );
}

// Everyone currently known to be online — the feed's "online now" rail
// (issue #554) lists the people you chat with from it.
export function useOnlineUserIds(): ReadonlySet<number> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
