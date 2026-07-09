// Tracks the highest `version` (see `Chat.version`, src/db/schema.ts) this
// client has observed for each chat, from whichever source saw it last —
// either a REST fetch that returned the chat (see chats.ts) or a
// `chat_updated` WS event (see realtimeSocket.ts). This is what lets the
// socket handler tell a stale/duplicate event apart from a real gap
// deterministically (issue #55), rather than treating every push as
// equally-informative and just refetching blind.
const versions = new Map<number, number>();

// Records `version` as the latest known state for `chatId`, if it's newer
// than what's already known. Safe to call with an out-of-order or repeated
// value — only ever moves a chat's tracked version forward.
export function recordChatVersion(chatId: number, version: number): void {
  const known = versions.get(chatId);
  if (known === undefined || version > known) versions.set(chatId, version);
}

export type ChatVersionClassification = "stale" | "gap" | "sequential";

// Classifies an incoming `chat_updated` event's version against what's
// already known for that chat:
//  - "stale": at or behind the last known version — a redelivery (e.g. after
//    a Redis/WS reconnect) of something already applied, safe to ignore.
//  - "gap": strictly ahead of `known + 1` — at least one update in between
//    was missed.
//  - "sequential": exactly the next version, or nothing was known yet (the
//    common case, and always the case for a chat this client hasn't fetched
//    over REST yet).
export function classifyChatVersion(
  chatId: number,
  version: number,
): ChatVersionClassification {
  const known = versions.get(chatId);
  if (known !== undefined && version <= known) return "stale";
  if (known !== undefined && version > known + 1) return "gap";
  return "sequential";
}
