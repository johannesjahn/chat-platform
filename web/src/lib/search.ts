import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchClient } from "./api";
import { userLabel } from "./users";
import type { components } from "./api-types";

export type SearchSnippetSegment =
  components["schemas"]["SearchSnippetSegment"];
export type PostSearchResult = components["schemas"]["PostSearchResult"];
export type CommentSearchResult = components["schemas"]["CommentSearchResult"];
export type MessageSearchResult = components["schemas"]["MessageSearchResult"];
export type MessageSearchChat = components["schemas"]["MessageSearchChat"];

// Below this a search isn't selective enough to be worth a round trip —
// mirrors `MIN_SEARCH_QUERY_LENGTH` in src/Api.ts, so the client rejects a
// too-short query before it ever reaches (and is rejected by) the server.
export const MIN_SEARCH_QUERY_LENGTH = 2;

// One page per fetch; the server caps this at `MAX_SEARCH_LIMIT` (50).
const SEARCH_PAGE_LIMIT = 20;

// Query-key prefixes (openapi-react-query-style `[method, path]`) so all three
// searches can be invalidated by prefix after login/logout, alongside the
// per-query text below.
export const searchPostsQueryKey = (q: string) =>
  ["search", "posts", q] as const;
export const searchCommentsQueryKey = (q: string) =>
  ["search", "comments", q] as const;
export const searchMessagesQueryKey = (q: string) =>
  ["search", "messages", q] as const;

// The URL query object every search page fetch sends — the query text, a fixed
// page size, and (past the first page) the opaque keyset cursor.
const searchParams = (q: string, cursor: string | null) => ({
  q,
  limit: String(SEARCH_PAGE_LIMIT),
  ...(cursor !== null ? { cursor } : {}),
});

// `fetchClient` (not the typed `$api.useInfiniteQuery`) is used for the same
// reason `usePostsFeed` does: it carries the auth header and lets the opaque
// cursor drive `pageParam`. Each hook pins a concrete path so the response
// type is inferred precisely (a union path would blur the three result shapes).
export function useSearchPosts(q: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: searchPostsQueryKey(q),
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await fetchClient.GET("/search/posts", {
        params: { query: searchParams(q, pageParam) },
        signal,
      });
      if (error) throw error;
      return data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useSearchComments(q: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: searchCommentsQueryKey(q),
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await fetchClient.GET("/search/comments", {
        params: { query: searchParams(q, pageParam) },
        signal,
      });
      if (error) throw error;
      return data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useSearchMessages(q: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: searchMessagesQueryKey(q),
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await fetchClient.GET("/search/messages", {
        params: { query: searchParams(q, pageParam) },
        signal,
      });
      if (error) throw error;
      return data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

// Display name for the chat a message hit belongs to — the group title, or the
// other participant of a direct chat (mirrors `chatDisplayName` in chats.ts,
// but over the lighter `MessageSearchChat` a search page returns).
export function messageSearchChatName(
  chat: MessageSearchChat,
  currentUserId: number,
): string {
  if (chat.type === "group") return chat.title ?? "Group chat";
  const other = chat.participants.find((p) => p.userId !== currentUserId);
  return other ? userLabel(other) : "Direct chat";
}
