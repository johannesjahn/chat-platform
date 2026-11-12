// The chat queries' keys — their own module, with no imports, so code that
// only needs to address the cache (lib/chatSync.ts) doesn't pull in the API
// client with them. Re-exported from chats.ts, which most code imports.

export const chatsListQueryKey = ["chats", "list"] as const;
// The Unread filter's server-side list and the unread total behind the
// badges (issue #756). Both extend `chatsListQueryKey` on purpose: every
// place that refreshes the chat list — the `chat_updated`/`chat_deleted`
// realtime events, markRead, sends, joins, leaves — invalidates that key,
// and invalidation matches by prefix, so they're refreshed by exactly the
// same events with nothing extra to keep in sync.
export const unreadChatsListQueryKey = [
  ...chatsListQueryKey,
  "unread",
] as const;
// Message requests (issue #785): `GET /chats?requests=true`, the chats the
// main list leaves out until they're accepted. Under `chatsListQueryKey` for
// the same reason as the two keys around it.
export const chatRequestsListQueryKey = [
  ...chatsListQueryKey,
  "requests",
] as const;
export const chatsUnreadCountQueryKey = [
  ...chatsListQueryKey,
  "unread-count",
] as const;
export const chatDetailQueryKey = (chatId: number) =>
  ["chats", chatId, "detail"] as const;
export const chatMessagesQueryKey = (chatId: number) =>
  ["chats", chatId, "messages"] as const;
// The chat-wide pinned list and the current user's private starred list
// (issue #223) are their own queries, kept separate from the paginated
// message window: a message can be pinned/starred while sitting outside the
// currently-loaded window, so the panels can't just be derived from it.
export const chatPinnedQueryKey = (chatId: number) =>
  ["chats", chatId, "pinned"] as const;
export const chatStarredQueryKey = (chatId: number) =>
  ["chats", chatId, "starred"] as const;
