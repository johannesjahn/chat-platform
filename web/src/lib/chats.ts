import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchClient } from "./api";
import type { components } from "./api-types";

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
export function useChatsList(enabled: boolean) {
  return useQuery({
    queryKey: chatsListQueryKey,
    enabled,
    queryFn: async () => {
      const { data, error } = await fetchClient.GET("/chats", {});
      if (error) throw error;
      return data;
    },
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

export function useTotalUnreadCount(enabled: boolean): number {
  const { data } = useChatsList(enabled);
  return (data ?? []).reduce((sum, chat) => sum + chat.unreadCount, 0);
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
      return data;
    },
  });
}

async function fetchMessagesPage(
  chatId: number,
  offset: number,
  limit: number,
) {
  const { data, error } = await fetchClient.GET("/chats/{id}/messages", {
    params: {
      path: { id: String(chatId) },
      query: { offset: String(offset), limit: String(limit) },
    },
  });
  if (error) throw error;
  return data;
}

// Chats read oldest-first server-side (offset/limit, same shape as posts'
// pagination) but a conversation should *open* on its newest messages, like
// WhatsApp/Telegram. So this keeps a "window anchor" — the offset the
// currently-loaded page starts at — and:
//  - on first load, probes the total then jumps the anchor to the last
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

  const query = useQuery({
    queryKey:
      chatId != null
        ? chatMessagesQueryKey(chatId)
        : ["chats", "messages", "none"],
    enabled: enabled && chatId != null,
    queryFn: async () => {
      const id = chatId!;
      if (anchorRef.current === null) {
        const probe = await fetchMessagesPage(id, 0, MESSAGES_PAGE_SIZE);
        anchorRef.current = Math.max(0, probe.total - MESSAGES_PAGE_SIZE);
      }
      let offset = anchorRef.current;
      let page = await fetchMessagesPage(id, offset, MESSAGES_MAX_LIMIT);
      if (page.offset + page.messages.length < page.total) {
        // More messages exist than this window (capped at
        // MESSAGES_MAX_LIMIT) can show from the current anchor — slide the
        // anchor forward just enough to keep the newest messages in view,
        // then re-fetch so the returned `offset`/`messages` reflect the
        // anchor that's actually used going forward. Sliding all the way
        // back to the last page here (instead of by the max limit) is what
        // caused the anchor tracked for the *next* `loadEarlier` call to
        // diverge from what was actually rendered, producing both a scroll
        // jump to the newest messages and a subsequent re-fetch of a
        // range that had already been loaded.
        offset = Math.max(0, page.total - MESSAGES_MAX_LIMIT);
        anchorRef.current = offset;
        page = await fetchMessagesPage(id, offset, MESSAGES_MAX_LIMIT);
      }
      return {
        messages: page.messages,
        total: page.total,
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
    return query.refetch();
  };

  return { ...query, loadEarlier };
}
