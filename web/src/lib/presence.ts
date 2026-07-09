import { useSyncExternalStore } from "react";

// Tracks who's currently online, fed by `presence` WS events (see
// realtimeSocket.ts). Deliberately a plain module-level store rather than a
// React Query cache entry: there's no REST resource behind it to refetch —
// the WS connection *is* the source of truth — so a subscribe/notify store
// read via `useSyncExternalStore` is a more honest fit than shoehorning it
// into `queryClient.setQueryData`.
const onlineUserIds = new Set<number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

// Applies one user's online/offline transition — both the live pushes after
// connecting and the initial "who's online" snapshot (sent as a burst of
// individual `online: true` events right after the socket opens, see
// RealtimeSocket.ts) go through this same path.
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

// Clears all known presence state. Called when a fresh `/ws` connection is
// about to open (including on reconnect) — a connection drop can mean any
// number of users went offline/online without this client hearing about it,
// so starting clean and letting the new connection's initial snapshot
// repopulate it avoids showing stale "online" dots.
export function resetPresence(): void {
  if (onlineUserIds.size === 0) return;
  onlineUserIds.clear();
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
