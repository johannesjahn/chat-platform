import { and, count, eq, inArray } from "drizzle-orm";
import type { DrizzleDb } from "./Db.ts";
import { likes } from "./db/schema.ts";

// Like counts are computed on read rather than stored in a denormalized
// counter column (see the comment on `likes` in db/schema.ts): a grouped
// COUNT over `likes` for the visible ids, plus a second query for which of
// them the current user liked. Both are keyed off the target FK columns,
// which are indexed, so a page's worth stays cheap. Kept here (rather than in
// a handler) so both PostsHandler and EngagementHandler share one
// implementation.

export type LikeInfo = {
  readonly likeCount: number;
  readonly likedByMe: boolean;
};

// `likeCount`/`likedByMe` for a batch of post ids, in one grouped count query
// and one "which did I like" query. Every requested id is present in the
// result (0/false if it has no likes at all).
export const postLikeInfo = async (
  db: DrizzleDb,
  postIds: ReadonlyArray<number>,
  userId: number,
): Promise<Map<number, LikeInfo>> => {
  const result = new Map<number, LikeInfo>();
  if (postIds.length === 0) return result;
  const ids = [...postIds];

  const counts = await db
    .select({ postId: likes.postId, total: count() })
    .from(likes)
    .where(inArray(likes.postId, ids))
    .groupBy(likes.postId);
  const mine = await db
    .select({ postId: likes.postId })
    .from(likes)
    .where(and(eq(likes.userId, userId), inArray(likes.postId, ids)));

  const likedByMe = new Set(mine.map((row) => row.postId));
  const countById = new Map<number, number>();
  for (const row of counts) {
    if (row.postId !== null) countById.set(row.postId, Number(row.total));
  }
  for (const id of ids) {
    result.set(id, {
      likeCount: countById.get(id) ?? 0,
      likedByMe: likedByMe.has(id),
    });
  }
  return result;
};

// Same as `postLikeInfo`, for comment (and reply) ids — likes on comments and
// replies share the one `likes` table.
export const commentLikeInfo = async (
  db: DrizzleDb,
  commentIds: ReadonlyArray<number>,
  userId: number,
): Promise<Map<number, LikeInfo>> => {
  const result = new Map<number, LikeInfo>();
  if (commentIds.length === 0) return result;
  const ids = [...commentIds];

  const counts = await db
    .select({ commentId: likes.commentId, total: count() })
    .from(likes)
    .where(inArray(likes.commentId, ids))
    .groupBy(likes.commentId);
  const mine = await db
    .select({ commentId: likes.commentId })
    .from(likes)
    .where(and(eq(likes.userId, userId), inArray(likes.commentId, ids)));

  const likedByMe = new Set(mine.map((row) => row.commentId));
  const countById = new Map<number, number>();
  for (const row of counts) {
    if (row.commentId !== null) countById.set(row.commentId, Number(row.total));
  }
  for (const id of ids) {
    result.set(id, {
      likeCount: countById.get(id) ?? 0,
      likedByMe: likedByMe.has(id),
    });
  }
  return result;
};

// Convenience single-target lookups for the like/unlike endpoints, which need
// exactly one target's state to return. Fall back to 0/false if the target
// somehow has no rows (e.g. an unlike that removed the last like).
export const postLikeInfoOne = async (
  db: DrizzleDb,
  postId: number,
  userId: number,
): Promise<LikeInfo> =>
  (await postLikeInfo(db, [postId], userId)).get(postId) ?? {
    likeCount: 0,
    likedByMe: false,
  };

export const commentLikeInfoOne = async (
  db: DrizzleDb,
  commentId: number,
  userId: number,
): Promise<LikeInfo> =>
  (await commentLikeInfo(db, [commentId], userId)).get(commentId) ?? {
    likeCount: 0,
    likedByMe: false,
  };
