import {
  infiniteQueryOptions,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { fetchClient } from "./api";
import type { components } from "./api-types";
import {
  type CommentsData,
  appendComment,
  commentQueryBelongsToPost,
  patchComment,
  topLevelCommentIds,
} from "./commentPages";
import { patchCachedPost } from "./posts";
import { refetchUnlessWarmed } from "./routeLoader";

export type Comment = components["schemas"]["Comment"];

// Content is capped server-side (`MAX_COMMENT_CONTENT_LENGTH` in src/Api.ts) —
// mirrored here so the composer can show a live counter without a round-trip.
export const MAX_COMMENT_CONTENT_LENGTH = 2_000;

const COMMENTS_PAGE_SIZE = 20;

// Query-key roots. openapi-react-query keys its own queries as
// `[method, path, init]`, but comments/replies are infinite queries driven by
// `fetchClient` directly (same reason as the posts feed — the typed
// `useInfiniteQuery` wrapper can't vary its page param), so they use these
// hand-rolled keys instead. `commentsQueryKeyRoot` is the shared prefix of
// them all; a `comment_changed` only refetches the ones belonging to its
// post (see `invalidatePostComments`).
export const commentsQueryKeyRoot = ["comments"] as const;
export const postCommentsQueryKey = (postId: number) =>
  ["comments", "post", postId] as const;
export const commentRepliesQueryKey = (commentId: number) =>
  ["comments", "replies", commentId] as const;
export const commentQueryKey = (commentId: number) =>
  ["comments", "one", commentId] as const;

// Oldest-first, keyset-paginated top-level comments on a post — replies are
// fetched separately per comment via `useReplies`. The options are shared
// with the post route's loader (see routes/posts/$id/index.tsx).
export function useComments(postId: number, enabled: boolean) {
  return useInfiniteQuery({ ...postCommentsQueryOptions(postId), enabled });
}

export function postCommentsQueryOptions(postId: number) {
  return infiniteQueryOptions({
    queryKey: postCommentsQueryKey(postId),
    refetchOnMount: refetchUnlessWarmed,
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

// One comment or reply on its own — the notifications preview pane (issue
// #564) uses it to show the comment a notification points at in its thread.
// Under `commentsQueryKeyRoot`, so the same realtime events refresh it.
export function useComment(commentId: number, enabled: boolean) {
  return useQuery({
    queryKey: commentQueryKey(commentId),
    enabled,
    queryFn: async ({ signal }) => {
      const { data, error } = await fetchClient.GET("/comments/{id}", {
        params: { path: { id: String(commentId) } },
        signal,
      });
      if (error) throw error;
      return data;
    },
  });
}

// Refetches the comment queries showing post `postId`'s comments — its
// thread, its comments' reply threads, and any of its comments shown on their
// own — and leaves every other post's open section alone (issue #753). What a
// `comment_changed` for that post invalidates.
export function invalidatePostComments(
  queryClient: QueryClient,
  postId: number,
): Promise<void> {
  const topLevelIds = topLevelCommentIds(
    queryClient.getQueryData<CommentsData>(postCommentsQueryKey(postId)),
  );
  return queryClient.invalidateQueries({
    queryKey: commentsQueryKeyRoot,
    predicate: (query) =>
      commentQueryBelongsToPost(
        query.queryKey,
        query.state.data,
        postId,
        topLevelIds,
      ),
  });
}

// Writes this client's own just-created comment or reply (the mutation
// response) into the cache in place of refetching (issue #753): onto the end
// of its thread, the parent's `replyCount` and the post's `commentCount` up by
// one. Its realtime echo is then dropped (see ownWrites.ts).
export function addCreatedComment(
  queryClient: QueryClient,
  comment: Comment,
): void {
  const parentId = comment.parentCommentId;
  if (parentId === null) {
    queryClient.setQueryData<CommentsData>(
      postCommentsQueryKey(comment.postId),
      (data) => (data ? appendComment(data, comment) : data),
    );
  } else {
    queryClient.setQueryData<CommentsData>(
      commentRepliesQueryKey(parentId),
      (data) => (data ? appendComment(data, comment) : data),
    );
    const bump = (parent: Comment) => ({
      ...parent,
      replyCount: parent.replyCount + 1,
    });
    queryClient.setQueryData<CommentsData>(
      postCommentsQueryKey(comment.postId),
      (data) => (data ? patchComment(data, parentId, bump) : data),
    );
    queryClient.setQueryData<Comment>(commentQueryKey(parentId), (data) =>
      data ? bump(data) : data,
    );
  }
  patchCachedPost(queryClient, comment.postId, (post) => ({
    ...post,
    commentCount: post.commentCount + 1,
  }));
}
