import { HttpApiBuilder } from "@effect/platform";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { Effect } from "effect";
import {
  ChatApi,
  DEFAULT_COMMENTS_LIMIT,
  Forbidden,
  InvalidCommentRequest,
  NotFound,
  TooManyRequests,
} from "./Api.ts";
import { CurrentUser } from "./Auth.ts";
import { Db } from "./Db.ts";
import {
  commentLikeInfo,
  commentLikeInfoOne,
  type LikeInfo,
  postLikeInfoOne,
} from "./likes.ts";
import { RateLimiter } from "./RateLimiter.ts";
import { RealtimeConnections } from "./Realtime.ts";
import { comments, likes, posts } from "./db/schema.ts";

const NO_LIKES: LikeInfo = { likeCount: 0, likedByMe: false };

// Defense-in-depth cap on engagement writes (likes, comments, replies) per
// user, mirroring the auth-endpoint limiters (see UsersHandler.ts). A single
// authenticated user rapidly toggling a like is otherwise a cheap way to
// amplify load — each post like fans out a realtime event to every connected
// client — so all the mutating endpoints share one per-user bucket. The limit
// is generous (a human clicking never approaches ~2/sec sustained for a
// minute) but bounds a scripted flood. Reads (`listComments`/`listReplies`)
// aren't limited here — they're paginated and covered by the global limiter.
const ENGAGEMENT_WRITE_MAX_PER_USER = 120;
const ENGAGEMENT_WRITE_WINDOW_SECONDS = 60;

const enforceEngagementLimit = (userId: number) =>
  Effect.gen(function* () {
    const limiter = yield* RateLimiter;
    const result = yield* limiter.consume(
      `engagement:write:user:${userId}`,
      ENGAGEMENT_WRITE_MAX_PER_USER,
      ENGAGEMENT_WRITE_WINDOW_SECONDS,
    );
    if (!result.allowed)
      return yield* Effect.fail(
        new TooManyRequests({
          message: "Too many requests. Please try again later.",
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
  });

const toApiComment = (
  row: typeof comments.$inferSelect,
  like: LikeInfo = NO_LIKES,
) => ({
  id: row.id,
  postId: row.postId,
  parentCommentId: row.parentCommentId,
  authorId: row.authorId,
  content: row.content,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  likeCount: like.likeCount,
  likedByMe: like.likedByMe,
});

// Author or admin — the same ownership rule posts use (see PostsHandler.ts).
const canModify = (
  currentUser: { readonly id: number; readonly role: string },
  comment: { readonly authorId: number },
): boolean =>
  currentUser.role === "admin" || comment.authorId === currentUser.id;

// Comments/replies are ordered oldest-first (`id asc`) and never reorder, so a
// single forward keyset cursor is enough — the last row's id, base64url
// encoded, exactly like `listPosts` (see PostsHandler.ts).
const encodeCommentsCursor = (id: number): string =>
  Buffer.from(String(id)).toString("base64url");

const decodeCommentsCursor = (cursor: string): number | null => {
  const id = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isInteger(id) ? id : null;
};

const getPostOr404 = (id: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* Effect.tryPromise(() =>
      db.select().from(posts).where(eq(posts.id, id)).limit(1),
    ).pipe(Effect.orDie);
    const row = rows[0];
    if (!row)
      return yield* Effect.fail(
        new NotFound({ message: `Post ${id} not found` }),
      );
    return row;
  });

const getCommentOr404 = (id: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* Effect.tryPromise(() =>
      db.select().from(comments).where(eq(comments.id, id)).limit(1),
    ).pipe(Effect.orDie);
    const row = rows[0];
    if (!row)
      return yield* Effect.fail(
        new NotFound({ message: `Comment ${id} not found` }),
      );
    return row;
  });

// Shared by `listComments` (top-level, filtered on a null parent) and
// `listReplies` (a comment's children): a keyset page over `comments` in
// `id asc` order, decorated with per-row like info for the current user.
const listThread = (
  where: ReturnType<typeof and>,
  cursor: string | undefined,
  limit: number,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const currentUser = yield* CurrentUser;

    let after: number | null = null;
    if (cursor !== undefined) {
      after = decodeCommentsCursor(cursor);
      if (after === null)
        return yield* Effect.fail(
          new InvalidCommentRequest({ message: "Invalid cursor" }),
        );
    }

    // Fetch one past `limit` to derive `nextCursor` without a separate
    // COUNT(*), same trick as `listPosts`.
    const fetched = yield* Effect.tryPromise(() =>
      db
        .select()
        .from(comments)
        .where(after !== null ? and(where, gt(comments.id, after)) : where)
        .orderBy(asc(comments.id))
        .limit(limit + 1),
    ).pipe(Effect.orDie);
    const hasMore = fetched.length > limit;
    const rows = fetched.slice(0, limit);
    const lastRow = rows[rows.length - 1];
    const nextCursor =
      hasMore && lastRow ? encodeCommentsCursor(lastRow.id) : null;

    const likeInfo = yield* Effect.tryPromise(() =>
      commentLikeInfo(
        db,
        rows.map((r) => r.id),
        currentUser.id,
      ),
    ).pipe(Effect.orDie);

    return {
      comments: rows.map((r) => toApiComment(r, likeInfo.get(r.id))),
      limit,
      nextCursor,
    };
  });

export const EngagementHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "comments",
  (handlers) =>
    handlers
      .handle("likePost", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          yield* enforceEngagementLimit(currentUser.id);
          yield* getPostOr404(id);
          // Idempotent: the (userId, postId) unique constraint turns a repeat
          // like into a no-op rather than a duplicate row or an error.
          // `.returning()` lets us tell an actual new like from a no-op so we
          // only fan out a realtime event when the count really changed.
          const inserted = yield* Effect.tryPromise(() =>
            db
              .insert(likes)
              .values({ userId: currentUser.id, postId: id })
              .onConflictDoNothing()
              .returning(),
          ).pipe(Effect.orDie);
          const info = yield* Effect.tryPromise(() =>
            postLikeInfoOne(db, id, currentUser.id),
          ).pipe(Effect.orDie);
          if (inserted.length > 0) {
            yield* connections.broadcastAll({
              type: "like_changed",
              targetType: "post",
              targetId: id,
              likeCount: info.likeCount,
            });
          }
          return { likeCount: info.likeCount, liked: info.likedByMe };
        }),
      )
      .handle("unlikePost", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          yield* enforceEngagementLimit(currentUser.id);
          yield* getPostOr404(id);
          const deleted = yield* Effect.tryPromise(() =>
            db
              .delete(likes)
              .where(
                and(eq(likes.userId, currentUser.id), eq(likes.postId, id)),
              )
              .returning(),
          ).pipe(Effect.orDie);
          const info = yield* Effect.tryPromise(() =>
            postLikeInfoOne(db, id, currentUser.id),
          ).pipe(Effect.orDie);
          // Only broadcast if a like was actually removed — unliking something
          // not liked is a no-op and shouldn't fan out a redundant event.
          if (deleted.length > 0) {
            yield* connections.broadcastAll({
              type: "like_changed",
              targetType: "post",
              targetId: id,
              likeCount: info.likeCount,
            });
          }
          return { likeCount: info.likeCount, liked: info.likedByMe };
        }),
      )
      .handle("listComments", ({ path: { id }, urlParams }) =>
        Effect.gen(function* () {
          yield* getPostOr404(id);
          return yield* listThread(
            and(eq(comments.postId, id), isNull(comments.parentCommentId)),
            urlParams.cursor,
            urlParams.limit ?? DEFAULT_COMMENTS_LIMIT,
          );
        }),
      )
      .handle("createComment", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          yield* enforceEngagementLimit(currentUser.id);
          yield* getPostOr404(id);
          const now = new Date();
          const rows = yield* Effect.tryPromise(() =>
            db
              .insert(comments)
              .values({
                postId: id,
                parentCommentId: null,
                authorId: currentUser.id,
                content: payload.content,
                createdAt: now,
                updatedAt: now,
              })
              .returning(),
          ).pipe(Effect.orDie);
          const row = rows[0];
          if (!row)
            return yield* Effect.die(new Error("INSERT returned no rows"));
          yield* connections.notifyPostRoom(id, {
            type: "comment_changed",
            postId: id,
            commentId: row.id,
          });
          return toApiComment(row);
        }),
      )
      .handle("listReplies", ({ path: { id }, urlParams }) =>
        Effect.gen(function* () {
          yield* getCommentOr404(id);
          return yield* listThread(
            eq(comments.parentCommentId, id),
            urlParams.cursor,
            urlParams.limit ?? DEFAULT_COMMENTS_LIMIT,
          );
        }),
      )
      .handle("createReply", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          yield* enforceEngagementLimit(currentUser.id);
          const parent = yield* getCommentOr404(id);
          // Depth-2 cap: the target must itself be a top-level comment. A
          // parent that already has its own parent is a reply, and replies
          // can't be replied to (see the `comments` schema comment).
          if (parent.parentCommentId !== null)
            return yield* Effect.fail(
              new InvalidCommentRequest({
                message: "Cannot reply to a reply",
              }),
            );
          const now = new Date();
          const rows = yield* Effect.tryPromise(() =>
            db
              .insert(comments)
              .values({
                postId: parent.postId,
                parentCommentId: parent.id,
                authorId: currentUser.id,
                content: payload.content,
                createdAt: now,
                updatedAt: now,
              })
              .returning(),
          ).pipe(Effect.orDie);
          const row = rows[0];
          if (!row)
            return yield* Effect.die(new Error("INSERT returned no rows"));
          yield* connections.notifyPostRoom(parent.postId, {
            type: "comment_changed",
            postId: parent.postId,
            commentId: row.id,
          });
          return toApiComment(row);
        }),
      )
      .handle("likeComment", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          yield* enforceEngagementLimit(currentUser.id);
          const comment = yield* getCommentOr404(id);
          const inserted = yield* Effect.tryPromise(() =>
            db
              .insert(likes)
              .values({ userId: currentUser.id, commentId: id })
              .onConflictDoNothing()
              .returning(),
          ).pipe(Effect.orDie);
          const info = yield* Effect.tryPromise(() =>
            commentLikeInfoOne(db, id, currentUser.id),
          ).pipe(Effect.orDie);
          // Per-comment likes stay scoped to the post's room, not broadcast
          // feed-wide (see LikeEvent in Realtime.ts). Only emit on an actual
          // new like, not a redundant re-like.
          if (inserted.length > 0) {
            yield* connections.notifyPostRoom(comment.postId, {
              type: "like_changed",
              targetType: "comment",
              targetId: id,
              likeCount: info.likeCount,
            });
          }
          return { likeCount: info.likeCount, liked: info.likedByMe };
        }),
      )
      .handle("unlikeComment", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          yield* enforceEngagementLimit(currentUser.id);
          const comment = yield* getCommentOr404(id);
          const deleted = yield* Effect.tryPromise(() =>
            db
              .delete(likes)
              .where(
                and(eq(likes.userId, currentUser.id), eq(likes.commentId, id)),
              )
              .returning(),
          ).pipe(Effect.orDie);
          const info = yield* Effect.tryPromise(() =>
            commentLikeInfoOne(db, id, currentUser.id),
          ).pipe(Effect.orDie);
          if (deleted.length > 0) {
            yield* connections.notifyPostRoom(comment.postId, {
              type: "like_changed",
              targetType: "comment",
              targetId: id,
              likeCount: info.likeCount,
            });
          }
          return { likeCount: info.likeCount, liked: info.likedByMe };
        }),
      )
      .handle("updateComment", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          yield* enforceEngagementLimit(currentUser.id);
          const existing = yield* getCommentOr404(id);
          if (!canModify(currentUser, existing))
            return yield* Effect.fail(
              new Forbidden({
                message: "You can only edit your own comments",
              }),
            );
          const rows = yield* Effect.tryPromise(() =>
            db
              .update(comments)
              .set({ content: payload.content, updatedAt: new Date() })
              .where(eq(comments.id, id))
              .returning(),
          ).pipe(Effect.orDie);
          const row = rows[0];
          if (!row)
            return yield* Effect.die(new Error("UPDATE returned no rows"));
          const like = yield* Effect.tryPromise(() =>
            commentLikeInfoOne(db, id, currentUser.id),
          ).pipe(Effect.orDie);
          yield* connections.notifyPostRoom(row.postId, {
            type: "comment_changed",
            postId: row.postId,
            commentId: row.id,
          });
          return toApiComment(row, like);
        }),
      )
      .handle("deleteComment", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          yield* enforceEngagementLimit(currentUser.id);
          const existing = yield* getCommentOr404(id);
          if (!canModify(currentUser, existing))
            return yield* Effect.fail(
              new Forbidden({
                message: "You can only delete your own comments",
              }),
            );
          // Deleting a top-level comment cascades to its replies and every
          // like on it (FKs in db/schema.ts) — the client refetches the
          // thread on the event, so no per-row cleanup here.
          yield* Effect.tryPromise(() =>
            db.delete(comments).where(eq(comments.id, id)),
          ).pipe(Effect.orDie);
          yield* connections.notifyPostRoom(existing.postId, {
            type: "comment_changed",
            postId: existing.postId,
            commentId: id,
          });
        }),
      ),
);
