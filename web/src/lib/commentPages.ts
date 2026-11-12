import type { InfiniteData, QueryKey } from "@tanstack/react-query";
import type { components } from "./api-types";

// Pure edits to, and matching of, the cached comment/reply queries — kept
// free of any client/browser import so they can be unit-tested on their own
// (see commentPages.test.ts). Used to write a just-created comment into the
// cache instead of refetching it, and to scope a `comment_changed` event to
// the one post it's about (issue #753).

type Comment = components["schemas"]["Comment"];
type CommentsPage = components["schemas"]["CommentsPage"];

export type CommentsData = InfiniteData<CommentsPage, string | null>;

function containsComment(data: CommentsData, commentId: number): boolean {
  return data.pages.some((page) =>
    page.comments.some((comment) => comment.id === commentId),
  );
}

// Appends a just-created comment (or reply) to its cached thread. Threads are
// oldest-first, so it belongs at the very end — on screen only once the last
// page is loaded; with more pages still to come it arrives with the last of
// them, exactly as a refetch would have left it.
export function appendComment(
  data: CommentsData,
  comment: Comment,
): CommentsData {
  if (containsComment(data, comment.id)) return data;
  const last = data.pages.at(-1);
  if (!last || last.nextCursor !== null) return data;
  return {
    ...data,
    pages: [
      ...data.pages.slice(0, -1),
      { ...last, comments: [...last.comments, comment] },
    ],
  };
}

// Applies `update` to one comment wherever it sits in a cached thread.
// Returns `data` itself when it isn't there, so React Query sees no change.
export function patchComment(
  data: CommentsData,
  commentId: number,
  update: (comment: Comment) => Comment,
): CommentsData {
  if (!containsComment(data, commentId)) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      comments: page.comments.map((comment) =>
        comment.id === commentId ? update(comment) : comment,
      ),
    })),
  };
}

// Whether a query under `commentsQueryKeyRoot` (see comments.ts) shows part
// of post `postId`'s comments: its top-level thread, the replies of one of
// its comments, or one of its comments on its own. `topLevelIds` are the
// post's cached top-level comment ids, which is how a reply thread is tied to
// its post when it has no rows yet to say so. A query with no data yet is
// matched — it's about to fetch anyway, and costs nothing to include.
export function commentQueryBelongsToPost(
  queryKey: QueryKey,
  data: unknown,
  postId: number,
  topLevelIds: ReadonlySet<number>,
): boolean {
  const [root, kind, id] = queryKey;
  if (root !== "comments") return false;
  if (kind === "post") return id === postId;
  if (kind === "replies") {
    if (typeof id === "number" && topLevelIds.has(id)) return true;
    if (data === undefined) return true;
    return (data as CommentsData).pages.some((page) =>
      page.comments.some((comment) => comment.postId === postId),
    );
  }
  if (kind === "one") {
    return data === undefined || (data as Comment).postId === postId;
  }
  return false;
}

export function topLevelCommentIds(
  data: CommentsData | undefined,
): Set<number> {
  return new Set(
    data?.pages.flatMap((page) => page.comments.map((comment) => comment.id)) ??
      [],
  );
}
