import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { fetchClient } from "./api";
import { userLabel } from "./users";
import type { components } from "./api-types";

export type SearchSnippetSegment =
  components["schemas"]["SearchSnippetSegment"];
export type UserSearchResult = components["schemas"]["UserSearchResult"];
export type PostSearchResult = components["schemas"]["PostSearchResult"];
export type CommentSearchResult = components["schemas"]["CommentSearchResult"];
export type MessageSearchResult = components["schemas"]["MessageSearchResult"];
export type MessageSearchChat = components["schemas"]["MessageSearchChat"];
export type SearchAllPage = components["schemas"]["SearchAllPage"];

// Below this a search isn't selective enough to be worth a round trip —
// mirrors `MIN_SEARCH_QUERY_LENGTH` in src/Api.ts, so the client rejects a
// too-short query before it ever reaches (and is rejected by) the server.
export const MIN_SEARCH_QUERY_LENGTH = 2;

// Fragments shorter than this can't be served by the trigram indexes, so the
// backend answers them with word/prefix matching only — the UI says so rather
// than leaving a user wondering why "ab" didn't find "grab". Mirrors
// `MIN_SUBSTRING_TOKEN_LENGTH` in src/search.ts.
export const MIN_FRAGMENT_QUERY_LENGTH = 3;

// One page per fetch for a section's own tab; the server caps this at
// `MAX_SEARCH_LIMIT` (50).
const SEARCH_PAGE_LIMIT = 20;

// How many rows each section previews on the "All" tab. Mirrors
// `DEFAULT_SEARCH_ALL_LIMIT` in src/Api.ts (and stays within
// `MAX_SEARCH_ALL_LIMIT`).
const SEARCH_ALL_LIMIT = 5;

// A search result is a snapshot of a moving feed, and re-running the same
// query a few seconds later is very unlikely to be worth a round trip —
// especially while the user flips between tabs for the same text. Long enough
// to make tab switching instant, short enough that a fresh search after
// posting something still sees it.
const SEARCH_STALE_TIME_MS = 30_000;

export const searchAllQueryKey = (q: string) => ["search", "all", q] as const;
export const searchUsersQueryKey = (q: string) =>
  ["search", "users", q] as const;
export const searchPostsQueryKey = (q: string) =>
  ["search", "posts", q] as const;
export const searchCommentsQueryKey = (q: string) =>
  ["search", "comments", q] as const;
export const searchMessagesQueryKey = (q: string) =>
  ["search", "messages", q] as const;

// The URL query object a per-section page fetch sends — the query text, a
// fixed page size, and (past the first page) the opaque keyset cursor.
const searchParams = (q: string, cursor: string | null) => ({
  q,
  limit: String(SEARCH_PAGE_LIMIT),
  ...(cursor !== null ? { cursor } : {}),
});

// The whole results page in one request: people, posts, comments and messages
// together (the backend runs the four queries concurrently). `keepPreviousData`
// is what makes typing feel instant — the previous query's results stay on
// screen, dimmed, instead of collapsing to a spinner on every keystroke that
// survives the debounce.
export function useSearchAll(q: string, enabled: boolean) {
  return useQuery({
    queryKey: searchAllQueryKey(q),
    enabled,
    staleTime: SEARCH_STALE_TIME_MS,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const { data, error } = await fetchClient.GET("/search", {
        params: { query: { q, limit: String(SEARCH_ALL_LIMIT) } },
        signal,
      });
      if (error) throw error;
      return data;
    },
  });
}

// `fetchClient` (not the typed `$api.useInfiniteQuery`) is used for the same
// reason `usePostsFeed` does: it carries the auth header and lets the opaque
// cursor drive `pageParam`. Each hook pins a concrete path so the response
// type is inferred precisely (a union path would blur the four result shapes).
export function useSearchUsers(q: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: searchUsersQueryKey(q),
    enabled,
    staleTime: SEARCH_STALE_TIME_MS,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await fetchClient.GET("/search/users", {
        params: { query: searchParams(q, pageParam) },
        signal,
      });
      if (error) throw error;
      return data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useSearchPosts(q: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: searchPostsQueryKey(q),
    enabled,
    staleTime: SEARCH_STALE_TIME_MS,
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
    staleTime: SEARCH_STALE_TIME_MS,
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
    staleTime: SEARCH_STALE_TIME_MS,
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
