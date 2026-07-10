import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchClient } from "./api";
import type { components } from "./api-types";

export type Post = components["schemas"]["Post"];
export type PostContentType = components["schemas"]["PostContentType"];

// Content is capped server-side (`MAX_POST_CONTENT_LENGTH` in src/Api.ts) —
// kept in sync here so the form can show a live counter/limit client-side.
export const MAX_POST_CONTENT_LENGTH = 10_000;

// Feed batch sizes: a fuller first screen, then smaller batches as the user
// scrolls, for the infinite-scroll feed on `/posts`.
export const INITIAL_POSTS_LIMIT = 5;
export const LOAD_MORE_POSTS_LIMIT = 3;

export const postsFeedQueryKey = ["posts", "feed"] as const;

// Prefix of the query key `$api.useQuery("get", "/posts/{id}", ...)`
// generates (openapi-react-query keys queries as `[method, path, init]`).
// `queryClient.invalidateQueries` matches by prefix by default, so this
// invalidates every currently-mounted single-post query regardless of which
// id it was fetched with — used by `useRealtimeSocket` on a `post_changed`
// event, since the event doesn't say which page happens to have it open.
export const postDetailQueryKeyPrefix = ["get", "/posts/{id}"] as const;

// The typed `$api.useInfiniteQuery` wrapper only supports a single, constant
// query param driving pagination — it can't express a batch size that varies
// between the first page and subsequent ones. So this talks to `fetchClient`
// (the same client `$api` wraps, auth header and all) directly instead.
//
// The server paginates with a keyset cursor rather than offset/limit (issue
// #50), so `pageParam` carries the opaque cursor for the next page (`null`
// for the first) instead of a numeric offset.
export function usePostsFeed(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: postsFeedQueryKey,
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const limit =
        pageParam === null ? INITIAL_POSTS_LIMIT : LOAD_MORE_POSTS_LIMIT;
      const { data, error } = await fetchClient.GET("/posts", {
        params: {
          query: {
            limit: String(limit),
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
