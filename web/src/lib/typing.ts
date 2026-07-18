import { useSyncExternalStore } from "react";

export type TypingUser = {
  userId: number;
  username: string;
  displayName: string | null;
};

// The server pushes a `typing` event per keystroke burst but never a
// corresponding "stopped typing" event (see src/Api.ts's `sendTyping` — it's
// deliberately stateless). So each entry here just times itself out if no
// fresh `typing` event for the same chat/user refreshes it first — long
// enough to bridge ChatComposer's throttle gap (see TYPING_THROTTLE_MS
// there) without the indicator visibly flickering off between sends.
const TYPING_TTL_MS = 4_000;

const byChat = new Map<number, Map<number, TypingUser>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
// Memoized per-chat snapshot arrays, invalidated whenever that chat's typing
// set changes — `useSyncExternalStore` requires `getSnapshot` to return a
// referentially stable value when nothing changed, so this avoids handing
// back a fresh array (and triggering a re-render) on every unrelated read.
const snapshots = new Map<number, TypingUser[]>();

function notify(): void {
  for (const listener of listeners) listener();
}

function timerKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

// Also called directly (not just from the TTL timeout below) when a message
// from this user actually arrives — see `useChatMessages`'s consumer in
// routes/chats/$id.tsx. That's the common case: the sender's `typing` event
// TTL (4s) comfortably outlasts the time it takes their message to arrive,
// so without this the indicator would otherwise sit there for however much
// of the TTL was left after the message rendered. The stale timer for this
// key (if any) still fires later, but by then `users.delete` below is
// already a no-op, so no `clearTimeout` is needed here.
export function clearTyping(chatId: number, userId: number): void {
  const users = byChat.get(chatId);
  if (!users?.delete(userId)) return;
  if (users.size === 0) byChat.delete(chatId);
  snapshots.delete(chatId);
  timers.delete(timerKey(chatId, userId));
  notify();
}

export function noteTyping(
  chatId: number,
  userId: number,
  username: string,
  displayName: string | null,
): void {
  const users = byChat.get(chatId) ?? new Map<number, TypingUser>();
  users.set(userId, { userId, username, displayName });
  byChat.set(chatId, users);
  snapshots.delete(chatId);

  const key = timerKey(chatId, userId);
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => clearTyping(chatId, userId), TYPING_TTL_MS),
  );
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: ReadonlyArray<TypingUser> = [];

export function useTypingUsers(
  chatId: number | undefined,
): ReadonlyArray<TypingUser> {
  return useSyncExternalStore(subscribe, () => {
    if (chatId == null) return EMPTY;
    const cached = snapshots.get(chatId);
    if (cached) return cached;
    const snapshot = [...(byChat.get(chatId)?.values() ?? [])];
    snapshots.set(chatId, snapshot);
    return snapshot;
  });
}
