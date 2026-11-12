/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { components } from "./api-types";
import {
  type CommentsData,
  appendComment,
  commentQueryBelongsToPost,
  patchComment,
  topLevelCommentIds,
} from "./commentPages";

type Comment = components["schemas"]["Comment"];

const comment = (
  id: number,
  postId = 1,
  parentCommentId: number | null = null,
): Comment => ({
  id,
  postId,
  parentCommentId,
  authorId: 1,
  author: {
    id: 1,
    username: "user1",
    displayName: null,
    avatarUrl: null,
    avatarVariants: null,
  },
  content: `comment ${id}`,
  createdAt: id,
  updatedAt: id,
  reactions: [],
  replyCount: 0,
});

const thread = (
  pages: Array<{ ids: number[]; next: string | null }>,
  postId = 1,
): CommentsData => ({
  pages: pages.map(({ ids, next }) => ({
    comments: ids.map((id) => comment(id, postId)),
    limit: 20,
    nextCursor: next,
  })),
  pageParams: pages.map((_, i) => (i === 0 ? null : `c${i}`)),
});

const ids = (data: CommentsData) =>
  data.pages.map((page) => page.comments.map((c) => c.id));

describe("appendComment", () => {
  test("adds a new comment to the end of a fully loaded thread", () => {
    const data = thread([
      { ids: [1, 2], next: "c1" },
      { ids: [3], next: null },
    ]);
    expect(ids(appendComment(data, comment(4)))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("leaves the thread alone while more pages are still to come, or when it's there", () => {
    const partial = thread([{ ids: [1, 2], next: "c1" }]);
    expect(appendComment(partial, comment(9))).toBe(partial);
    const full = thread([{ ids: [1, 2], next: null }]);
    expect(appendComment(full, comment(2))).toBe(full);
  });
});

describe("patchComment", () => {
  test("updates the one comment, or returns the thread itself when it's absent", () => {
    const data = thread([{ ids: [1, 2], next: null }]);
    const patched = patchComment(data, 2, (c) => ({ ...c, replyCount: 3 }));
    expect(patched.pages[0]?.comments.map((c) => c.replyCount)).toEqual([0, 3]);
    expect(patchComment(data, 9, (c) => c)).toBe(data);
  });
});

describe("commentQueryBelongsToPost", () => {
  const topLevel = topLevelCommentIds(thread([{ ids: [10, 11], next: null }]));
  const belongs = (key: unknown[], data: unknown) =>
    commentQueryBelongsToPost(key, data, 1, topLevel);

  test("matches this post's thread and not another post's", () => {
    expect(belongs(["comments", "post", 1], undefined)).toBe(true);
    expect(belongs(["comments", "post", 2], undefined)).toBe(false);
  });

  test("matches reply threads of this post's comments, by parent or by rows", () => {
    const otherPostReplies = thread([{ ids: [30], next: null }], 2);
    expect(belongs(["comments", "replies", 10], otherPostReplies)).toBe(true);
    expect(belongs(["comments", "replies", 20], otherPostReplies)).toBe(false);
    const ownReplies = thread([{ ids: [31], next: null }], 1);
    expect(belongs(["comments", "replies", 21], ownReplies)).toBe(true);
    expect(belongs(["comments", "replies", 22], undefined)).toBe(true);
  });

  test("matches a single comment of this post", () => {
    expect(belongs(["comments", "one", 10], comment(10, 1))).toBe(true);
    expect(belongs(["comments", "one", 40], comment(40, 2))).toBe(false);
  });

  test("ignores keys outside the comments root", () => {
    expect(belongs(["posts", "feed"], undefined)).toBe(false);
  });
});
