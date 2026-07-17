import { useRef } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { fetchClient } from "./api";
import type { components } from "./api-types";
import { recordChatVersion } from "./chatVersions";

export type Chat = components["schemas"]["Chat"];
export type ChatType = components["schemas"]["ChatType"];
export type ChatParticipant = components["schemas"]["ChatParticipant"];
export type ChatMessage = components["schemas"]["Message"];
export type MessageContentType = components["schemas"]["MessageContentType"];

// Kept in sync with the server-side caps (`MAX_MESSAGE_CONTENT_LENGTH`,
// `MAX_GROUP_PARTICIPANTS` in src/Api.ts) so the UI can show live
// counters/limits without a round-trip.
export const MAX_MESSAGE_CONTENT_LENGTH = 4_000;
export const MAX_GROUP_PARTICIPANTS = 20;

// A message bubble longer than this is collapsed behind "Show more", the
// same idea as PostCard's threshold but shorter — chat bubbles are narrow.
export const MESSAGE_COLLAPSE_THRESHOLD = 300;

const MESSAGES_PAGE_SIZE = 10;
const MESSAGES_MAX_LIMIT = 100;

type MessagesPageResponse = components["schemas"]["MessagesPage"];

export const chatsListQueryKey = ["chats", "list"] as const;
export const chatDetailQueryKey = (chatId: number) =>
  ["chats", chatId, "detail"] as const;
export const chatMessagesQueryKey = (chatId: number) =>
  ["chats", chatId, "messages"] as const;

// Chat list is shared between the nav's unread badge and the `/chats` page —
// same query key, so React Query dedupes the underlying request and both
// consumers see the same data. Kept fresh by `useChatSocket`, which
// invalidates this key whenever the `/ws` connection reports a `chat_updated`
// event for any chat the current user is part of — no polling.
//
// The server paginates with a keyset cursor rather than returning every chat
// at once (issue #49), so this is an infinite query: each page carries the
// cursor for the next one, and `fetchNextPage` walks forward. Callers that
// just want everything loaded so far (e.g. the unread badge) can flatten
// `data.pages`.
export function useChatsList(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: chatsListQueryKey,
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await fetchClient.GET("/chats", {
        params: { query: pageParam ? { cursor: pageParam } : {} },
        signal,
      });
      if (error) throw error;
      for (const chat of data.chats) recordChatVersion(chat.id, chat.version);
      return data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function chatDisplayName(chat: Chat, currentUserId: number): string {
  if (chat.type === "group") return chat.title ?? "Group chat";
  const other = chat.participants.find((p) => p.userId !== currentUserId);
  return other ? `@${other.username}` : "Direct chat";
}

// Today shows a time, anything older shows a short date — the usual chat-app
// convention (WhatsApp/Telegram both do this) so the list stays scannable.
export function formatChatTimestamp(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  return isToday
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Only sums whichever pages have been fetched so far — for a user with more
// chats than fit in one page who hasn't opened `/chats` (and so never called
// `fetchNextPage`), this undercounts against chats past the first page,
// trading exactness for not re-introducing the unbounded fetch this
// pagination exists to avoid (issue #49).
export function useTotalUnreadCount(enabled: boolean): number {
  const { data } = useChatsList(enabled);
  return (data?.pages ?? []).reduce(
    (sum, page) =>
      sum + page.chats.reduce((pageSum, chat) => pageSum + chat.unreadCount, 0),
    0,
  );
}

export function useChatDetail(chatId: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey:
      chatId != null ? chatDetailQueryKey(chatId) : ["chats", "detail", "none"],
    enabled: enabled && chatId != null,
    queryFn: async () => {
      const { data, error } = await fetchClient.GET("/chats/{id}", {
        params: { path: { id: String(chatId) } },
      });
      if (error) throw error;
      recordChatVersion(data.id, data.version);
      return data;
    },
  });
}

// No cursor at all returns the newest window; `before`/`after` walk
// backward/forward from a previous page's `earliestCursor`/`latestCursor`
// (issue #50) — see `MessagesPageQuery` in src/Api.ts.
async function fetchMessagesPage(
  chatId: number,
  cursor:
    | { before: string; limit: number }
    | { after: string; limit: number }
    | { limit: number },
): Promise<MessagesPageResponse> {
  const { data, error } = await fetchClient.GET("/chats/{id}/messages", {
    params: {
      path: { id: String(chatId) },
      query: {
        limit: String(cursor.limit),
        ...("before" in cursor ? { before: cursor.before } : {}),
        ...("after" in cursor ? { after: cursor.after } : {}),
      },
    },
  });
  if (error) throw error;
  return data;
}

type ChatMessagesPage = {
  messages: ChatMessage[];
  hasEarlier: boolean;
};

// Appends a just-sent message straight into the cached page instead of
// waiting for the `chat_updated` WS round trip (server -> pubsub -> socket
// -> invalidate -> refetch) to bring it back — the POST response already
// *is* the canonical row, so there's no reason to re-fetch just to show it.
// The WS-triggered refetch still happens afterwards and reconciles anything
// this optimistic write can't know locally (e.g. other participants' read
// receipts), same as it does for every other participant's client.
export function appendSentMessage(
  queryClient: QueryClient,
  chatId: number,
  message: ChatMessage,
) {
  queryClient.setQueryData<ChatMessagesPage>(
    chatMessagesQueryKey(chatId),
    (prev) => {
      if (!prev) return prev;
      if (prev.messages.some((m) => m.id === message.id)) return prev;
      return {
        ...prev,
        messages: [...prev.messages, message],
      };
    },
  );
}

// The server paginates messages with a keyset cursor rather than
// offset/limit (issue #50), keyed off the previous page's opaque
// `earliestCursor`/`latestCursor`. A conversation should *open* on its
// newest messages, like WhatsApp/Telegram, and the no-cursor request
// (`fetchMessagesPage(id, { limit })`) does exactly that server-side, so
// there's no equivalent of the old offset anchor to precompute — this hook
// just tracks the cursors bounding the currently-loaded window and:
//  - on first load, fetches the newest `MESSAGES_PAGE_SIZE` messages;
//  - on every refetch (triggered by `useChatSocket` invalidating this query
//    key on a `chat_updated` event), fetches only what's newer than the last
//    message already loaded (`after`) and appends it;
//  - if that would grow the window past `MESSAGES_MAX_LIMIT`, re-anchors with
//    a fresh newest-window fetch instead of trimming — a cursor for wherever
//    the trimmed-to front would land isn't something the client can
//    construct itself (cursors are opaque, server-issued only);
//  - `loadEarlier` fetches the page immediately before the oldest message
//    already loaded (`before`) and prepends it.
//
// The cursor refs are only ever mutated from the query/callback functions
// below, never during render — so the caller must mount a fresh component
// instance per chat (e.g. `<ChatView key={chatId} .../>`) rather than expect
// this hook to reset itself when `chatId` changes.
export function useChatMessages(chatId: number | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  const oldestCursorRef = useRef<string | null>(null);
  const newestCursorRef = useRef<string | null>(null);
  // Set by `loadEarlier` right before it triggers a refetch, and always
  // cleared by the queryFn below — distinguishes "the user just asked to
  // page backward" from "something else (the initial load, or a
  // `chat_updated`-triggered refetch at an unchanged window) re-ran this
  // query". Only the latter should catch up on newer messages — otherwise, in
  // a chat longer than MESSAGES_MAX_LIMIT, *every* `loadEarlier` call would
  // also race a forward catch-up fetch, making it impossible to ever page
  // further back and leaving `hasEarlier` permanently true — so scrolling to
  // the top kept sending pagination requests to the backend forever, even
  // once the oldest reachable message was loaded.
  const isLoadEarlierFetchRef = useRef(false);

  const queryKey =
    chatId != null
      ? chatMessagesQueryKey(chatId)
      : (["chats", "messages", "none"] as const);

  const query = useQuery({
    queryKey,
    enabled: enabled && chatId != null,
    queryFn: async (): Promise<ChatMessagesPage> => {
      const id = chatId!;
      const isLoadEarlierFetch = isLoadEarlierFetchRef.current;
      isLoadEarlierFetchRef.current = false;
      const prev = queryClient.getQueryData<ChatMessagesPage>(queryKey);
      // Whether *this hook instance* has already established a window,
      // rather than whether the query cache happens to have data — the
      // cache can outlive the instance (it survives for the default 5min
      // `gcTime` after `ChatView` unmounts, e.g. navigating to the chat list
      // and back), but the refs are reset on every fresh mount. Using `prev`
      // here instead would treat "reopening a chat visited earlier this
      // session" the same as "re-anchoring after outgrowing
      // MESSAGES_MAX_LIMIT", fetching a 100-message window on every reopen
      // instead of the intended 10-message first page.
      const hasWindowThisMount = newestCursorRef.current != null;

      if (isLoadEarlierFetch && prev && oldestCursorRef.current) {
        const page = await fetchMessagesPage(id, {
          before: oldestCursorRef.current,
          limit: MESSAGES_PAGE_SIZE,
        });
        oldestCursorRef.current = page.earliestCursor;
        return {
          messages: [...page.messages, ...prev.messages],
          hasEarlier: page.hasEarlier,
        };
      }

      if (prev && newestCursorRef.current) {
        const page = await fetchMessagesPage(id, {
          after: newestCursorRef.current,
          limit: MESSAGES_MAX_LIMIT,
        });
        if (page.messages.length === 0) return prev;
        // `newestCursorRef` isn't advanced by `appendSentMessage` (it has no
        // access to this hook's refs), so a `chat_updated`-triggered refetch
        // right after sending a message re-fetches "everything after the
        // stale cursor" — which includes the message already appended
        // optimistically. Drop anything already present by id so it isn't
        // duplicated in the merged list.
        const existingIds = new Set(prev.messages.map((m) => m.id));
        const newMessages = page.messages.filter((m) => !existingIds.has(m.id));
        if (prev.messages.length + newMessages.length <= MESSAGES_MAX_LIMIT) {
          newestCursorRef.current = page.latestCursor;
          return {
            messages: [...prev.messages, ...newMessages],
            hasEarlier: prev.hasEarlier,
          };
        }
        // Falls through to a fresh newest-window fetch below — see the
        // function comment on why this doesn't just trim client-side.
      }

      // True first load for this chat: only the newest small batch — a full
      // history isn't needed until the user scrolls up. A re-anchor after
      // outgrowing MESSAGES_MAX_LIMIT (the fallthrough above) instead re-fills
      // the full capped window, so the chat doesn't visibly shrink back down
      // to MESSAGES_PAGE_SIZE messages mid-conversation.
      const limit = hasWindowThisMount
        ? MESSAGES_MAX_LIMIT
        : MESSAGES_PAGE_SIZE;
      const page = await fetchMessagesPage(id, { limit });
      oldestCursorRef.current = page.earliestCursor;
      newestCursorRef.current = page.latestCursor;
      return { messages: page.messages, hasEarlier: page.hasEarlier };
    },
  });

  const loadEarlier = () => {
    isLoadEarlierFetchRef.current = true;
    return query.refetch();
  };

  return { ...query, loadEarlier };
}
