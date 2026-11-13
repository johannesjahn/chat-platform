import {
  infiniteQueryOptions,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { fetchClient } from "./api";
import type { components } from "./api-types";
import {
  chatRequestsListQueryKey,
  chatsListQueryKey,
  chatsUnreadCountQueryKey,
  chatDetailQueryKey,
  chatMessagesQueryKey,
  unreadChatsListQueryKey,
} from "./chatQueryKeys";
import { recordChatVersion } from "./chatVersions";
import { realtimeStaleTime } from "./realtimeFreshness";
import { refetchUnlessWarmed, warmed } from "./routeLoader";

// The chat queries the app shell and the route loaders need before anything
// else (issue #754): the nav's unread badge and what `/chats` and
// `/chats/$id` warm. Apart from chats.ts so the entry chunk doesn't carry the
// whole chat module — formatting, the message window hook, cache patchers —
// to every cold load. chats.ts re-exports all of it, so most code imports
// from there.

type ChatMessage = components["schemas"]["Message"];

// Matches the backend's `DEFAULT_MESSAGES_LIMIT` (src/Api.ts): enough to fill
// a tall desktop viewport on open, so the first page doesn't immediately
// trigger a "load earlier" fetch, while staying well under
// `MESSAGES_MAX_LIMIT` so several pages fit before a re-anchor.
export const MESSAGES_PAGE_SIZE = 30;
export const MESSAGES_MAX_LIMIT = 100;

export type MessagesPageResponse = components["schemas"]["MessagesPage"];

export function chatsListQueryOptions({
  unreadOnly = false,
  requestsOnly = false,
}: { unreadOnly?: boolean; requestsOnly?: boolean } = {}) {
  return infiniteQueryOptions({
    queryKey: requestsOnly
      ? chatRequestsListQueryKey
      : unreadOnly
        ? unreadChatsListQueryKey
        : chatsListQueryKey,
    refetchOnMount: refetchUnlessWarmed,
    // `chat_updated`/`chat_deleted` keep every chat list current while the
    // socket is up, so a mount doesn't refetch one (issue #752).
    staleTime: realtimeStaleTime(),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await fetchClient.GET("/chats", {
        params: {
          query: {
            ...(pageParam ? { cursor: pageParam } : {}),
            ...(unreadOnly ? { unread: "true" as const } : {}),
            ...(requestsOnly ? { requests: "true" as const } : {}),
          },
        },
        signal,
      });
      if (error) throw error;
      for (const chat of data.chats) recordChatVersion(chat.id, chat.version);
      return data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function chatsUnreadCountQueryOptions() {
  return queryOptions({
    queryKey: chatsUnreadCountQueryKey,
    staleTime: realtimeStaleTime(),
    queryFn: async ({ signal }) => {
      const { data, error } = await fetchClient.GET("/chats/unread-count", {
        signal,
      });
      if (error) throw error;
      return data;
    },
  });
}

/**
 * The viewer's unread messages over every chat they're in — the Chats nav
 * badge, the phone header badge, the dock and the tab title. Counted by the
 * server (`GET /chats/unread-count`, issue #756), not summed over the loaded
 * pages of the chat list, which only ever hold the newest chats: an unread
 * chat that has dropped off the first page still counts.
 */
export function useTotalUnreadCount(enabled: boolean): number {
  const { data } = useQuery({ ...chatsUnreadCountQueryOptions(), enabled });
  return data?.count ?? 0;
}

// Shared with the conversation route's loader (see routes/chats/$id.tsx).
export function chatDetailQueryOptions(chatId: number) {
  return queryOptions({
    queryKey: chatDetailQueryKey(chatId),
    refetchOnMount: refetchUnlessWarmed,
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
export async function fetchMessagesPage(
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

export type ChatMessagesPage = {
  messages: ChatMessage[];
  hasEarlier: boolean;
  // The cursors bounding `messages`, so a mount that adopts a window it
  // didn't fetch itself (see `useChatMessages`) can page on from it.
  // Optional: a window persisted before they were stored has none.
  earliestCursor?: string | null;
  latestCursor?: string | null;
};

// Warms a chat's newest window for its route's loader (see
// routes/chats/$id.tsx) — the same first page `useChatMessages` fetches on
// a fresh mount, which then adopts it. A window already cached is left as
// it is.
export function warmChatMessages(queryClient: QueryClient, chatId: number) {
  const queryKey = chatMessagesQueryKey(chatId);
  return warmed(
    queryKey,
    queryClient.ensureQueryData<ChatMessagesPage>({
      queryKey,
      queryFn: async () => {
        const page = await fetchMessagesPage(chatId, {
          limit: MESSAGES_PAGE_SIZE,
        });
        return {
          messages: page.messages,
          hasEarlier: page.hasEarlier,
          earliestCursor: page.earliestCursor,
          latestCursor: page.latestCursor,
        };
      },
    }),
  );
}
