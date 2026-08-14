import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { fetchClient } from "./api";
import type { components } from "./api-types";

export type Post = components["schemas"]["Post"];
export type PostContentType = components["schemas"]["PostContentType"];
type PostsPage = components["schemas"]["PostsPage"];
type UserPostsPage = components["schemas"]["UserPostsPage"];

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

// Prefix over every per-author `useUserPosts` infinite query (see
// `userPostsQueryKey` below) — the profile page's activity feed. Hand-rolled
// like `postsFeedQueryKey`/`postDetailQueryKeyPrefix` rather than an
// `$api.useInfiniteQuery` key for the same reason `usePostsFeed` is (see its
// comment): the batch size varies between the first page and subsequent ones.
export const userPostsQueryKeyPrefix = ["users", "posts"] as const;
export const userPostsQueryKey = (userId: number) =>
  [...userPostsQueryKeyPrefix, userId] as const;

// Applies `update` to a single post wherever it's cached — across the main
// feed's and every profile activity feed's infinite-query pages, and any
// mounted post-detail query — without a refetch. Used to reflect a reaction
// toggle from the `reaction_changed` realtime event's `reactions` payload
// (and the acting client's own mutation response) in place, rather than
// invalidating every one of those queries on every reaction for every
// connected client (which would be O(users × reactions) full-feed refetches).
export function patchCachedPost(
  queryClient: QueryClient,
  postId: number,
  update: (post: Post) => Post,
): void {
  queryClient.setQueriesData<InfiniteData<PostsPage>>(
    { queryKey: postsFeedQueryKey },
    (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              posts: page.posts.map((post) =>
                post.id === postId ? update(post) : post,
              ),
            })),
          }
        : data,
  );
  queryClient.setQueriesData<InfiniteData<UserPostsPage>>(
    { queryKey: userPostsQueryKeyPrefix },
    (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              posts: page.posts.map((post) =>
                post.id === postId ? update(post) : post,
              ),
            })),
          }
        : data,
  );
  queryClient.setQueriesData<Post>(
    { queryKey: postDetailQueryKeyPrefix },
    (data) => (data && data.id === postId ? update(data) : data),
  );
}

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

// A single user's recent posts, newest-first (issue #316) — backs the
// activity feed on their profile page. Same keyset-cursor pagination as
// `usePostsFeed`, just scoped to one author server-side (`GET
// /users/{id}/posts`), and its response additionally carries `totalCount`
// (the profile's "N posts" stat).
export function useUserPosts(userId: number, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: userPostsQueryKey(userId),
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const limit =
        pageParam === null ? INITIAL_POSTS_LIMIT : LOAD_MORE_POSTS_LIMIT;
      const { data, error } = await fetchClient.GET("/users/{id}/posts", {
        params: {
          path: { id: String(userId) },
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
