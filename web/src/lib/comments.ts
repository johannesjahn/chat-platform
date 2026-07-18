import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchClient } from "./api";
import type { components } from "./api-types";

export type Comment = components["schemas"]["Comment"];

// Content is capped server-side (`MAX_COMMENT_CONTENT_LENGTH` in src/Api.ts) —
// mirrored here so the composer can show a live counter without a round-trip.
export const MAX_COMMENT_CONTENT_LENGTH = 2_000;

const COMMENTS_PAGE_SIZE = 20;

// Query-key roots. openapi-react-query keys its own queries as
// `[method, path, init]`, but comments/replies are infinite queries driven by
// `fetchClient` directly (same reason as the posts feed — the typed
// `useInfiniteQuery` wrapper can't vary its page param), so they use these
// hand-rolled keys instead. `commentsQueryKeyRoot` is the shared prefix
// `useRealtimeSocket` invalidates on a `comment_changed`/`like_changed`
// (comment) event.
export const commentsQueryKeyRoot = ["comments"] as const;
export const postCommentsQueryKey = (postId: number) =>
  ["comments", "post", postId] as const;
export const commentRepliesQueryKey = (commentId: number) =>
  ["comments", "replies", commentId] as const;

// Oldest-first, keyset-paginated top-level comments on a post — replies are
// fetched separately per comment via `useReplies`.
export function useComments(postId: number, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: postCommentsQueryKey(postId),
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await fetchClient.GET("/posts/{id}/comments", {
        params: {
          path: { id: String(postId) },
          query: {
            limit: String(COMMENTS_PAGE_SIZE),
            ...(pageParam !== null ? { cursor: pageParam } : {}),
          },
        },
        signal,
      });
      if (error) throw error;
      return data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

// A comment's replies, oldest-first, same pagination shape as `useComments`.
export function useReplies(commentId: number, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: commentRepliesQueryKey(commentId),
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const { data, error } = await fetchClient.GET("/comments/{id}/replies", {
        params: {
          path: { id: String(commentId) },
          query: {
            limit: String(COMMENTS_PAGE_SIZE),
            ...(pageParam !== null ? { cursor: pageParam } : {}),
          },
        },
        signal,
      });
      if (error) throw error;
      return data;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}
