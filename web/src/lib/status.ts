import { useSyncExternalStore } from "react";

export type UserStatus = {
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiresAt: number | null;
};

// Live overrides fed by `status_changed` WS events (see realtimeSocket.ts),
// keyed by user id. Unlike `presence.ts`'s `onlineUserIds`, there's no
// "initial snapshot" burst to repopulate this on connect — status is already
// carried on `User`/`ChatParticipant` from their own REST responses, so a
// missing entry here just means "nothing has changed since that was
// fetched", not "unknown". `useUserStatus` below falls back to that
// REST-fetched value whenever this store has nothing fresher.
const statusByUserId = new Map<number, UserStatus>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

// A status update is a full-replace server-side (see UpdateStatusBody in
// src/Api.ts), so this always overwrites rather than merging field-by-field.
export function setUserStatus(userId: number, status: UserStatus): void {
  statusByUserId.set(userId, status);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// True when `status` has anything worth rendering — false for a fully-unset
// status, and for one whose `statusExpiresAt` has already passed (the server
// resolves this at read time too, see `effectiveStatus` in
// src/UsersHandler.ts, but a status fetched or pushed *before* its expiry can
// still be sitting in a client's cache/store after it elapses while the tab
// stays open).
export function isStatusVisible(
  status: UserStatus | null | undefined,
): status is UserStatus {
  if (!status) return false;
  if (status.statusExpiresAt !== null && status.statusExpiresAt <= Date.now())
    return false;
  return status.statusText !== null || status.statusEmoji !== null;
}

// Resolves the status to show for `userId`: a live `status_changed` push
// takes priority over `fallback` (the value embedded in whatever `User`/
// `ChatParticipant` the caller already fetched over REST) since it's
// guaranteed to be no older.
export function useUserStatus(
  userId: number | undefined,
  fallback: UserStatus | null | undefined,
): UserStatus | undefined {
  const live = useSyncExternalStore(subscribe, () =>
    userId != null ? statusByUserId.get(userId) : undefined,
  );
  return live ?? fallback ?? undefined;
}
