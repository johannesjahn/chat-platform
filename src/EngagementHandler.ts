import { HttpApiBuilder } from "effect/http-api";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { Effect, Metric } from "effect";
import {
  ChatApi,
  DEFAULT_COMMENTS_LIMIT,
  Forbidden,
  InvalidCommentRequest,
  NotFound,
  TooManyRequests,
} from "./Api.ts";
import { CurrentUser } from "./Auth.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { contentCreatedTotal, rateLimitRejectionsTotal } from "./Metrics.ts";
import {
  commentReactionInfo,
  commentReactionInfoOne,
  postReactionInfoOne,
  type ReactionSummary,
} from "./reactions.ts";
import {
  createNotifications,
  notifyMentions,
  retractReactionNotification,
} from "./notifications.ts";
import { RateLimiter } from "./RateLimiter.ts";
import { RealtimeConnections } from "./Realtime.ts";
import { comments, likes, posts } from "./db/schema.ts";

const NO_REACTIONS: ReactionSummary[] = [];

// The realtime broadcast only ever needs the aggregate counts, never
// `reactedByMe` — that field is inherently per-viewer, and a broadcast fans
// out to every connected client at once (see ReactionEvent in Realtime.ts).
const toReactionCounts = (reactions: ReadonlyArray<ReactionSummary>) =>
  reactions.map(({ emoji, count }) => ({ emoji, count }));

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

const enforceEngagementLimit = (
  limiter: RateLimiter["Service"],
  userId: number,
) =>
  Effect.gen(function* () {
    const result = yield* limiter.consume(
      `engagement:write:user:${userId}`,
      ENGAGEMENT_WRITE_MAX_PER_USER,
      ENGAGEMENT_WRITE_WINDOW_SECONDS,
    );
    if (!result.allowed) {
      yield* Metric.update(
        Metric.withAttributes(rateLimitRejectionsTotal, {
          limiter: "engagement",
        }),
        1,
      );
      return yield* Effect.fail(
        new TooManyRequests({
          message: "Too many requests. Please try again later.",
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
    }
  });

const recordContentCreated = (type: "comment" | "reaction") =>
  Metric.update(Metric.withAttributes(contentCreatedTotal, { type: type }), 1);

const toApiComment = (
  row: typeof comments.$inferSelect,
  reactions: ReadonlyArray<ReactionSummary> = NO_REACTIONS,
) => ({
  id: row.id,
  postId: row.postId,
  parentCommentId: row.parentCommentId,
  authorId: row.authorId,
  content: row.content,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  reactions: [...reactions],
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

const getPostOr404 = (db: DrizzleDb, id: number) =>
  Effect.gen(function* () {
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

const getCommentOr404 = (db: DrizzleDb, id: number) =>
  Effect.gen(function* () {
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
  db: DrizzleDb,
  where: ReturnType<typeof and>,
  cursor: string | undefined,
  limit: number,
) =>
  Effect.gen(function* () {
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

    const reactionInfo = yield* Effect.tryPromise(() =>
      commentReactionInfo(
        db,
        rows.map((r) => r.id),
        currentUser.id,
      ),
    ).pipe(Effect.orDie);

    return {
      comments: rows.map((r) => toApiComment(r, reactionInfo.get(r.id))),
      limit,
      nextCursor,
    };
  });

export const EngagementHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "comments",
  Effect.fn(function* (handlers) {
    const limiter = yield* RateLimiter;
    const db = yield* Db;
    const connections = yield* RealtimeConnections;
    return handlers
      .handle("addPostReaction", ({ params: { id }, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          yield* enforceEngagementLimit(limiter, currentUser.id);
          const post = yield* getPostOr404(db, id);
          // Idempotent: the (userId, postId, emoji) unique constraint turns a
          // repeat reaction with the same emoji into a no-op rather than a
          // duplicate row or an error. `.returning()` lets us tell an actual
          // new reaction from a no-op so we only fan out a realtime event
          // when the counts really changed.
          const inserted = yield* Effect.tryPromise(() =>
            db
              .insert(likes)
              .values({
                userId: currentUser.id,
                postId: id,
                emoji: payload.emoji,
              })
              .onConflictDoNothing()
              .returning(),
          ).pipe(Effect.orDie);
          const reactions = yield* Effect.tryPromise(() =>
            postReactionInfoOne(db, id, currentUser.id),
          ).pipe(Effect.orDie);
          if (inserted.length > 0) {
            yield* recordContentCreated("reaction");
            yield* connections.broadcastAll({
              type: "reaction_changed",
              targetType: "post",
              targetId: id,
              reactions: toReactionCounts(reactions),
            });
            yield* createNotifications({ db, connections }, [
              {
                userId: post.authorId,
                actorId: currentUser.id,
                type: "reaction",
                postId: id,
                emoji: payload.emoji,
              },
            ]);
          }
          return { reactions };
        }),
      )
      .handle("removePostReaction", ({ params: { id }, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          yield* enforceEngagementLimit(limiter, currentUser.id);
          yield* getPostOr404(db, id);
          const deleted = yield* Effect.tryPromise(() =>
            db
              .delete(likes)
              .where(
                and(
                  eq(likes.userId, currentUser.id),
                  eq(likes.postId, id),
                  eq(likes.emoji, payload.emoji),
                ),
              )
              .returning(),
          ).pipe(Effect.orDie);
          const reactions = yield* Effect.tryPromise(() =>
            postReactionInfoOne(db, id, currentUser.id),
          ).pipe(Effect.orDie);
          // Only broadcast if a reaction was actually removed — removing one
          // that isn't there is a no-op and shouldn't fan out a redundant
          // event.
          if (deleted.length > 0) {
            yield* connections.broadcastAll({
              type: "reaction_changed",
              targetType: "post",
              targetId: id,
              reactions: toReactionCounts(reactions),
            });
            yield* retractReactionNotification(
              { db, connections },
              {
                actorId: currentUser.id,
                emoji: payload.emoji,
                postId: id,
              },
            );
          }
          return { reactions };
        }),
      )
      .handle("listComments", ({ params: { id }, query: urlParams }) =>
        Effect.gen(function* () {
          yield* getPostOr404(db, id);
          return yield* listThread(
            db,
            and(eq(comments.postId, id), isNull(comments.parentCommentId)),
            urlParams.cursor,
            urlParams.limit ?? DEFAULT_COMMENTS_LIMIT,
          );
        }),
      )
      .handle("createComment", ({ params: { id }, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          yield* enforceEngagementLimit(limiter, currentUser.id);
          const post = yield* getPostOr404(db, id);
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
          yield* recordContentCreated("comment");
          yield* connections.notifyPostRoom(id, {
            type: "comment_changed",
            postId: id,
            commentId: row.id,
          });
          yield* createNotifications({ db, connections }, [
            {
              userId: post.authorId,
              actorId: currentUser.id,
              type: "comment",
              postId: id,
              commentId: row.id,
            },
          ]);
          // The post's author already hears about this comment above; a
          // mention of them in it would only notify them twice.
          yield* notifyMentions(
            { db, connections },
            {
              actorId: currentUser.id,
              content: row.content,
              postId: id,
              commentId: row.id,
              exclude: [post.authorId],
            },
          );
          return toApiComment(row);
        }),
      )
      .handle("listReplies", ({ params: { id }, query: urlParams }) =>
        Effect.gen(function* () {
          yield* getCommentOr404(db, id);
          return yield* listThread(
            db,
            eq(comments.parentCommentId, id),
            urlParams.cursor,
            urlParams.limit ?? DEFAULT_COMMENTS_LIMIT,
          );
        }),
      )
      .handle("createReply", ({ params: { id }, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          yield* enforceEngagementLimit(limiter, currentUser.id);
          const parent = yield* getCommentOr404(db, id);
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
          yield* recordContentCreated("comment");
          yield* connections.notifyPostRoom(parent.postId, {
            type: "comment_changed",
            postId: parent.postId,
            commentId: row.id,
          });
          yield* createNotifications({ db, connections }, [
            {
              userId: parent.authorId,
              actorId: currentUser.id,
              type: "reply",
              postId: parent.postId,
              commentId: row.id,
            },
          ]);
          yield* notifyMentions(
            { db, connections },
            {
              actorId: currentUser.id,
              content: row.content,
              postId: parent.postId,
              commentId: row.id,
              exclude: [parent.authorId],
            },
          );
          return toApiComment(row);
        }),
      )
      .handle("addCommentReaction", ({ params: { id }, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          yield* enforceEngagementLimit(limiter, currentUser.id);
          const comment = yield* getCommentOr404(db, id);
          const inserted = yield* Effect.tryPromise(() =>
            db
              .insert(likes)
              .values({
                userId: currentUser.id,
                commentId: id,
                emoji: payload.emoji,
              })
              .onConflictDoNothing()
              .returning(),
          ).pipe(Effect.orDie);
          const reactions = yield* Effect.tryPromise(() =>
            commentReactionInfoOne(db, id, currentUser.id),
          ).pipe(Effect.orDie);
          // Per-comment reactions stay scoped to the post's room, not
          // broadcast feed-wide (see ReactionEvent in Realtime.ts). Only emit
          // on an actual new reaction, not a redundant repeat.
          if (inserted.length > 0) {
            yield* recordContentCreated("reaction");
            yield* connections.notifyPostRoom(comment.postId, {
              type: "reaction_changed",
              targetType: "comment",
              targetId: id,
              reactions: toReactionCounts(reactions),
            });
            yield* createNotifications({ db, connections }, [
              {
                userId: comment.authorId,
                actorId: currentUser.id,
                type: "reaction",
                postId: comment.postId,
                commentId: id,
                emoji: payload.emoji,
              },
            ]);
          }
          return { reactions };
        }),
      )
      .handle("removeCommentReaction", ({ params: { id }, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          yield* enforceEngagementLimit(limiter, currentUser.id);
          const comment = yield* getCommentOr404(db, id);
          const deleted = yield* Effect.tryPromise(() =>
            db
              .delete(likes)
              .where(
                and(
                  eq(likes.userId, currentUser.id),
                  eq(likes.commentId, id),
                  eq(likes.emoji, payload.emoji),
                ),
              )
              .returning(),
          ).pipe(Effect.orDie);
          const reactions = yield* Effect.tryPromise(() =>
            commentReactionInfoOne(db, id, currentUser.id),
          ).pipe(Effect.orDie);
          if (deleted.length > 0) {
            yield* connections.notifyPostRoom(comment.postId, {
              type: "reaction_changed",
              targetType: "comment",
              targetId: id,
              reactions: toReactionCounts(reactions),
            });
            yield* retractReactionNotification(
              { db, connections },
              {
                actorId: currentUser.id,
                emoji: payload.emoji,
                commentId: id,
              },
            );
          }
          return { reactions };
        }),
      )
      .handle("updateComment", ({ params: { id }, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          yield* enforceEngagementLimit(limiter, currentUser.id);
          const existing = yield* getCommentOr404(db, id);
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
          const reactions = yield* Effect.tryPromise(() =>
            commentReactionInfoOne(db, id, currentUser.id),
          ).pipe(Effect.orDie);
          yield* connections.notifyPostRoom(row.postId, {
            type: "comment_changed",
            postId: row.postId,
            commentId: row.id,
          });
          // Only names added by this edit are pinged. Attributed to the
          // comment's author even when an admin made the edit — it's their
          // words the mention sits in.
          yield* notifyMentions(
            { db, connections },
            {
              actorId: row.authorId,
              content: row.content,
              previousContent: existing.content,
              postId: row.postId,
              commentId: row.id,
            },
          );
          return toApiComment(row, reactions);
        }),
      )
      .handle("deleteComment", ({ params: { id } }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          yield* enforceEngagementLimit(limiter, currentUser.id);
          const existing = yield* getCommentOr404(db, id);
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
      );
  }),
);
