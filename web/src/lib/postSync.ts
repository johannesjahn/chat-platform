import type { QueryClient } from "@tanstack/react-query";
import { fetchClient } from "./api";
import {
  type FeedData,
  type UserPostsData,
  feedHasPost,
  mergeNewestFeedPage,
  prependUserPost,
  removeFeedPost,
  removeUserPost,
} from "./postPages";
import {
  INITIAL_POSTS_LIMIT,
  type Post,
  patchCachedPost,
  postDetailQueryKeyPrefix,
  postsFeedQueryKey,
  userPostsQueryKey,
  userPostsQueryKeyPrefix,
} from "./posts";

// `change` is absent when talking to a server from before it was added —
// treated as "might be new", which is what every event used to mean.
export type PostChange = "created" | "updated" | "deleted";

// Applies one `post_changed` event to whatever this client has cached, at a
// cost of at most one request (issue #662). It used to invalidate the feed,
// every profile feed and every post detail — and an infinite query refetches
// *all* of its loaded pages, so a viewer scrolled 40 posts deep sent 13
// `GET /posts` for one post by someone else, on every connected client.
//
// - Deleted: dropped from the cache, no request.
// - A post we have cached: refetched alone (`GET /posts/:id`) and patched in
//   wherever it is, or dropped if it's gone by then.
// - Created (not cached yet): the feed's newest page is fetched once and
//   folded on top (see `mergeNewestFeedPage`) — fetched rather than
//   `GET /posts/:id` so the server's blocked/muted-author filter still
//   applies. An open profile feed of its author gets it on top too.
// - Updated, but not cached: nothing on screen shows it, nothing to do.
export async function syncChangedPost(
  queryClient: QueryClient,
  postId: number,
  change: PostChange | undefined,
): Promise<void> {
  if (change === "deleted") {
    removeCachedPost(queryClient, postId);
    return;
  }
  if (isPostCached(queryClient, postId)) {
    await refreshCachedPost(queryClient, postId);
    return;
  }
  if (change === "updated") return;
  await pullNewPost(queryClient, postId);
}

// Refetches one post and patches it in wherever it's cached — also what a
// `comment_changed` uses to update the post's `commentCount` in place.
export async function refreshCachedPost(
  queryClient: QueryClient,
  postId: number,
): Promise<void> {
  const { data, response } = await fetchClient
    .GET("/posts/{id}", { params: { path: { id: String(postId) } } })
    .catch(() => ({ data: undefined, response: undefined }));
  if (data) {
    patchCachedPost(queryClient, postId, () => data);
  } else if (response?.status === 404) {
    removeCachedPost(queryClient, postId);
  }
}

function isPostCached(queryClient: QueryClient, postId: number): boolean {
  return (
    feedHasPost(
      queryClient.getQueryData<FeedData>(postsFeedQueryKey),
      postId,
    ) ||
    queryClient
      .getQueriesData<UserPostsData>({ queryKey: userPostsQueryKeyPrefix })
      .some(([, data]) => feedHasPost(data, postId)) ||
    queryClient
      .getQueriesData<Post>({ queryKey: postDetailQueryKeyPrefix })
      .some(([, data]) => data?.id === postId)
  );
}

function removeCachedPost(queryClient: QueryClient, postId: number): void {
  queryClient.setQueryData<FeedData>(postsFeedQueryKey, (data) =>
    data ? removeFeedPost(data, postId) : data,
  );
  queryClient.setQueriesData<UserPostsData>(
    { queryKey: userPostsQueryKeyPrefix },
    (data) => (data ? removeUserPost(data, postId) : data),
  );
  // An open post page refetches its one post, so it shows "not found".
  void queryClient.invalidateQueries({
    queryKey: postDetailQueryKeyPrefix,
    predicate: (query) => (query.state.data as Post | undefined)?.id === postId,
  });
}

async function pullNewPost(
  queryClient: QueryClient,
  postId: number,
): Promise<void> {
  let post: Post | undefined;
  if (queryClient.getQueryData<FeedData>(postsFeedQueryKey)) {
    const { data } = await fetchClient
      .GET("/posts", {
        params: { query: { limit: String(INITIAL_POSTS_LIMIT) } },
      })
      .catch(() => ({ data: undefined }));
    if (data) {
      queryClient.setQueryData<FeedData>(postsFeedQueryKey, (cached) =>
        cached ? mergeNewestFeedPage(cached, data) : cached,
      );
      post = data.posts.find((p) => p.id === postId);
    }
  }

  const profileCached = queryClient
    .getQueriesData<UserPostsData>({ queryKey: userPostsQueryKeyPrefix })
    .some(([, data]) => data !== undefined);
  if (!profileCached) return;
  if (!post) {
    const { data } = await fetchClient
      .GET("/posts/{id}", { params: { path: { id: String(postId) } } })
      .catch(() => ({ data: undefined }));
    if (!data) return;
    post = data;
  }
  const created = post;
  queryClient.setQueryData<UserPostsData>(
    userPostsQueryKey(created.authorId),
    (data) => (data ? prependUserPost(data, created) : data),
  );
}
