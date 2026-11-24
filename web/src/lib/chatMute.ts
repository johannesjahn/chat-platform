import type { components } from "./api-types";

// Which chats the unread badge counts (issue #900). Type imports only, so
// chatSync.ts can use it without the API client. The fields are absent on a
// chat persisted before they existed, which reads as none of them.

type Chat = components["schemas"]["Chat"];

// Matches the server's `MUTED_FOREVER_MS` (src/api/chats.ts).
export const MUTED_FOREVER_MS = Date.UTC(9999, 11, 31);

export function isChatMuted(
  chat: Pick<Chat, "mutedUntil">,
  now: number = Date.now(),
): boolean {
  return chat.mutedUntil != null && chat.mutedUntil > now;
}

export function countsTowardUnread(
  chat: Pick<Chat, "mutedUntil" | "archived">,
): boolean {
  return !isChatMuted(chat) && !chat.archived;
}

// Whether the cached unread total may disagree with `countsTowardUnread`: the
// chat's mute ran out since it was fetched, and nothing announces that.
export function hasLapsedMute(chat: Pick<Chat, "mutedUntil">): boolean {
  return chat.mutedUntil != null && !isChatMuted(chat);
}

// A muted chat's unread badge still shows, but doesn't ask for attention.
export function unreadBadgeTone(chat: Pick<Chat, "mutedUntil">): string {
  return isChatMuted(chat)
    ? "bg-muted text-muted-foreground"
    : "bg-primary text-primary-foreground";
}
