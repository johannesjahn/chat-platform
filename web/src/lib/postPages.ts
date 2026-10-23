import type { InfiniteData } from "@tanstack/react-query";
import type { components } from "./api-types";

// Pure edits to the cached post feeds' infinite-query pages, kept free of
// any client/browser import so they can be unit-tested on their own (see
// postPages.test.ts). Used by postSync.ts to apply a single `post_changed`
// event in place instead of refetching every loaded page (issue #662).

type Post = components["schemas"]["Post"];
type PostsPage = components["schemas"]["PostsPage"];
type UserPostsPage = components["schemas"]["UserPostsPage"];

export type FeedData = InfiniteData<PostsPage, string | null>;
export type UserPostsData = InfiniteData<UserPostsPage, string | null>;

// Newest cached post id — the feeds are sorted `id desc`, so it's the first
// post of the first non-empty page.
function newestId(pages: ReadonlyArray<{ posts: Post[] }>): number | null {
  for (const page of pages) {
    const first = page.posts[0];
    if (first) return first.id;
  }
  return null;
}

function containsPost(
  pages: ReadonlyArray<{ posts: Post[] }>,
  postId: number,
): boolean {
  return pages.some((page) => page.posts.some((post) => post.id === postId));
}

export function feedHasPost(
  data: { pages: ReadonlyArray<{ posts: Post[] }> } | undefined,
  postId: number,
): boolean {
  return data ? containsPost(data.pages, postId) : false;
}

// Drops a post from every loaded page. Returns `data` itself when the post
// isn't there, so React Query sees no change. A page shrinking by one doesn't
// disturb paging: each page's `nextCursor` is keyed off its own last row.
export function removeFeedPost(data: FeedData, postId: number): FeedData {
  if (!containsPost(data.pages, postId)) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      posts: page.posts.filter((post) => post.id !== postId),
    })),
  };
}

// As `removeFeedPost`, also taking the post off the profile's "N posts".
export function removeUserPost(
  data: UserPostsData,
  postId: number,
): UserPostsData {
  if (!containsPost(data.pages, postId)) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      posts: page.posts.filter((post) => post.id !== postId),
      totalCount: Math.max(0, page.totalCount - 1),
    })),
  };
}

// Folds a freshly fetched first page (`fresh`, the newest posts) into the
// cached feed without refetching the pages below it: whatever in `fresh` is
// newer than the cached top goes on the front of page one. If `fresh` doesn't
// reach down to the cached top (more new posts arrived than one page holds),
// there'd be a hole between it and the cache, so the feed restarts from
// `fresh` alone — still one request, and scrolling pages on from there.
export function mergeNewestFeedPage(
  data: FeedData,
  fresh: PostsPage,
): FeedData {
  const topId = newestId(data.pages);
  const reachesCache =
    fresh.nextCursor === null ||
    (topId !== null && fresh.posts.some((post) => post.id <= topId));
  if (!reachesCache) return { pages: [fresh], pageParams: [null] };

  const newer = fresh.posts.filter(
    (post) =>
      (topId === null || post.id > topId) && !containsPost(data.pages, post.id),
  );
  if (newer.length === 0) return data;
  const [first, ...rest] = data.pages;
  if (!first) return { pages: [fresh], pageParams: [null] };
  return {
    ...data,
    pages: [{ ...first, posts: [...newer, ...first.posts] }, ...rest],
  };
}

// Puts a just-created post on the front of its author's profile feed. Only a
// post newer than everything cached belongs there — anything older is
// somewhere further down and will arrive with its page.
export function prependUserPost(
  data: UserPostsData,
  post: Post,
): UserPostsData {
  const topId = newestId(data.pages);
  if (topId !== null && post.id <= topId) return data;
  if (containsPost(data.pages, post.id)) return data;
  const [first, ...rest] = data.pages;
  if (!first) return data;
  return {
    ...data,
    pages: [{ ...first, posts: [post, ...first.posts] }, ...rest].map(
      (page) => ({ ...page, totalCount: page.totalCount + 1 }),
    ),
  };
}
