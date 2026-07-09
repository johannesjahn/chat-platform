import { useRef } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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

async function fetchMessagesPage(
  chatId: number,
  offset: number,
  limit: number,
  includeTotal = false,
) {
  const { data, error } = await fetchClient.GET("/chats/{id}/messages", {
    params: {
      path: { id: String(chatId) },
      query: {
        offset: String(offset),
        limit: String(limit),
        ...(includeTotal ? { includeTotal: "true" as const } : {}),
      },
    },
  });
  if (error) throw error;
  return data;
}

type ChatMessagesPage = {
  messages: ChatMessage[];
  // Whether more (newer) messages exist past this window — derived
  // server-side from an n+1 fetch rather than a `COUNT(*)` (issue #51).
  hasMore: boolean;
  offset: number;
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

// Chats read oldest-first server-side (offset/limit, same shape as posts'
// pagination) but a conversation should *open* on its newest messages, like
// WhatsApp/Telegram. So this keeps a "window anchor" — the offset the
// currently-loaded page starts at — and:
//  - on first load, probes the exact count (the one place that opts into the
//    server's `includeTotal`, since every other fetch below only needs
//    `hasMore` — see issue #51) then jumps the anchor to the last
//    `MESSAGES_PAGE_SIZE` messages instead of the first;
//  - on every refetch (triggered by `useChatSocket` invalidating this query
//    key on a `chat_updated` event), re-fetches from that same anchor with a
//    generous limit, so newly arrived messages are picked up without moving
//    the anchor;
//  - if the window fills up, slides the anchor forward to keep pace with the
//    newest messages;
//  - `loadEarlier` walks the anchor backward a page at a time.
//
// The anchor lives in a ref that's only ever mutated from the query/callback
// functions below, never during render — so the caller must mount a fresh
// component instance per chat (e.g. `<ChatView key={chatId} .../>`) rather
// than expect this hook to reset itself when `chatId` changes.
export function useChatMessages(chatId: number | undefined, enabled: boolean) {
  const anchorRef = useRef<number | null>(null);
  // Set by `loadEarlier` right before it triggers a refetch, and always
  // cleared by the queryFn below — distinguishes "the user just asked to
  // page backward" from "something else (the initial load, or a
  // `chat_updated`-triggered refetch at an unchanged anchor) re-ran this
  // query". Only the latter should slide the anchor forward to catch up with
  // the tail (see below) — otherwise, in a chat longer than
  // MESSAGES_MAX_LIMIT, *every* `loadEarlier` call would find its new anchor
  // still can't reach the tail within one MESSAGES_MAX_LIMIT-sized window
  // and immediately snap the anchor back toward the tail, making it
  // impossible to ever page further back and leaving `hasEarlier` permanently
  // true — so scrolling to the top kept sending pagination requests to the
  // backend forever, even once the oldest reachable message was loaded.
  const isLoadEarlierFetchRef = useRef(false);

  const query = useQuery({
    queryKey:
      chatId != null
        ? chatMessagesQueryKey(chatId)
        : ["chats", "messages", "none"],
    enabled: enabled && chatId != null,
    queryFn: async () => {
      const id = chatId!;
      const isLoadEarlierFetch = isLoadEarlierFetchRef.current;
      isLoadEarlierFetchRef.current = false;
      if (anchorRef.current === null) {
        const probe = await fetchMessagesPage(id, 0, MESSAGES_PAGE_SIZE, true);
        anchorRef.current = Math.max(
          0,
          (probe.total ?? 0) - MESSAGES_PAGE_SIZE,
        );
      }
      const offset = anchorRef.current;
      const page = await fetchMessagesPage(id, offset, MESSAGES_MAX_LIMIT);
      const loadedThrough = page.offset + page.messages.length;
      if (!isLoadEarlierFetch && page.hasMore) {
        // More messages exist than this window (capped at
        // MESSAGES_MAX_LIMIT) can show from the current anchor — rather than
        // re-requesting the whole window again (this is the common case
        // once a chat has grown past MESSAGES_MAX_LIMIT and the anchor sits
        // pinned to the tail, since *any* new message re-triggers it), fetch
        // only the rows past what was just loaded and merge them in. Sliding
        // all the way back to the last page here (instead of by the max
        // limit) is what caused the anchor tracked for the *next*
        // `loadEarlier` call to diverge from what was actually rendered,
        // producing both a scroll jump to the newest messages and a
        // subsequent re-fetch of a range that had already been loaded.
        const tail = await fetchMessagesPage(
          id,
          loadedThrough,
          MESSAGES_MAX_LIMIT,
        );
        const merged = [...page.messages, ...tail.messages].slice(
          -MESSAGES_MAX_LIMIT,
        );
        const newOffset = tail.offset + tail.messages.length - merged.length;
        anchorRef.current = newOffset;
        return {
          messages: merged,
          hasMore: tail.hasMore,
          offset: newOffset,
          hasEarlier: newOffset > 0,
        };
      }
      return {
        messages: page.messages,
        hasMore: page.hasMore,
        offset: page.offset,
        hasEarlier: page.offset > 0,
      };
    },
  });

  const loadEarlier = () => {
    anchorRef.current = Math.max(
      0,
      (anchorRef.current ?? 0) - MESSAGES_PAGE_SIZE,
    );
    isLoadEarlierFetchRef.current = true;
    return query.refetch();
  };

  return { ...query, loadEarlier };
}
