/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { components } from "./api-types";
import {
  type FeedData,
  type UserPostsData,
  feedHasPost,
  mergeNewestFeedPage,
  prependUserPost,
  removeFeedPost,
  removeUserPost,
} from "./postPages";

type Post = components["schemas"]["Post"];

const post = (id: number, authorId = 1): Post => ({
  id,
  authorId,
  contentType: "text",
  content: `post ${id}`,
  attachment: null,
  createdAt: id,
  updatedAt: id,
  reactions: [],
  commentCount: 0,
});

const page = (ids: number[], nextCursor: string | null) => ({
  posts: ids.map((id) => post(id)),
  limit: ids.length,
  nextCursor,
});

// Three loaded pages: 10..6, 5..3, 2..1 (the end of the feed).
const feed = (): FeedData => ({
  pages: [
    page([10, 9, 8, 7, 6], "c6"),
    page([5, 4, 3], "c3"),
    page([2, 1], null),
  ],
  pageParams: [null, "c6", "c3"],
});

const ids = (data: { pages: ReadonlyArray<{ posts: Post[] }> }) =>
  data.pages.map((p) => p.posts.map((x) => x.id));

describe("mergeNewestFeedPage", () => {
  test("puts posts newer than the cached top on the front of page one, leaving the rest alone", () => {
    const data = feed();
    const merged = mergeNewestFeedPage(data, page([12, 11, 10, 9, 8], "c8"));
    expect(ids(merged)).toEqual([
      [12, 11, 10, 9, 8, 7, 6],
      [5, 4, 3],
      [2, 1],
    ]);
    expect(merged.pageParams).toEqual(data.pageParams);
    expect(merged.pages[1]).toBe(data.pages[1]!);
    expect(merged.pages[0]!.nextCursor).toBe("c6");
  });

  test("returns the cache itself when nothing is new", () => {
    const data = feed();
    expect(mergeNewestFeedPage(data, page([10, 9, 8, 7, 6], "c6"))).toBe(data);
  });

  test("restarts from the fresh page when it doesn't reach the cached top", () => {
    const fresh = page([20, 19, 18, 17, 16], "c16");
    expect(mergeNewestFeedPage(feed(), fresh)).toEqual({
      pages: [fresh],
      pageParams: [null],
    });
  });

  test("fills an empty feed", () => {
    const empty: FeedData = { pages: [page([], null)], pageParams: [null] };
    expect(ids(mergeNewestFeedPage(empty, page([1], null)))).toEqual([[1]]);
  });
});

describe("removeFeedPost", () => {
  test("drops the post from whichever page has it", () => {
    expect(ids(removeFeedPost(feed(), 4))).toEqual([
      [10, 9, 8, 7, 6],
      [5, 3],
      [2, 1],
    ]);
  });

  test("returns the cache itself when the post isn't there", () => {
    const data = feed();
    expect(removeFeedPost(data, 99)).toBe(data);
  });
});

describe("profile feeds", () => {
  const profile = (): UserPostsData => ({
    pages: [
      { ...page([7, 5], "c5"), totalCount: 3 },
      { ...page([2], null), totalCount: 3 },
    ],
    pageParams: [null, "c5"],
  });

  test("prependUserPost adds a newer post on top and bumps the count", () => {
    const next = prependUserPost(profile(), post(9));
    expect(ids(next)).toEqual([[9, 7, 5], [2]]);
    expect(next.pages.map((p) => p.totalCount)).toEqual([4, 4]);
  });

  test("prependUserPost ignores a post older than the cached top", () => {
    const data = profile();
    expect(prependUserPost(data, post(6))).toBe(data);
  });

  test("removeUserPost drops it and lowers the count", () => {
    const next = removeUserPost(profile(), 2);
    expect(ids(next)).toEqual([[7, 5], []]);
    expect(next.pages.map((p) => p.totalCount)).toEqual([2, 2]);
  });

  test("feedHasPost looks across every page", () => {
    expect(feedHasPost(profile(), 2)).toBe(true);
    expect(feedHasPost(profile(), 3)).toBe(false);
    expect(feedHasPost(undefined, 2)).toBe(false);
  });
});
