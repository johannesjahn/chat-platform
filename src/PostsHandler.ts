import { HttpApiBuilder } from "@effect/platform";
import { desc, eq, lt } from "drizzle-orm";
import { Effect, Metric, MetricLabel } from "effect";
import {
  ChatApi,
  DEFAULT_POSTS_LIMIT,
  Forbidden,
  InvalidPostsRequest,
  NotFound,
} from "./Api.ts";
import { CurrentUser } from "./Auth.ts";
import { Db } from "./Db.ts";
import { type LikeInfo, postLikeInfo } from "./likes.ts";
import { contentCreatedTotal } from "./Metrics.ts";
import { RealtimeConnections } from "./Realtime.ts";
import { posts } from "./db/schema.ts";

const NO_LIKES: LikeInfo = { likeCount: 0, likedByMe: false };

const toApiPost = (
  row: typeof posts.$inferSelect,
  like: LikeInfo = NO_LIKES,
) => ({
  id: row.id,
  authorId: row.authorId,
  contentType: row.contentType,
  content: row.content,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  likeCount: like.likeCount,
  likedByMe: like.likedByMe,
});

// Admins can edit/delete any post; everyone else only their own.
const canModify = (
  currentUser: { readonly id: number; readonly role: string },
  post: { readonly authorId: number },
): boolean => currentUser.role === "admin" || post.authorId === currentUser.id;

// Keyset cursor for `listPosts` over its `id desc` sort — see
// `PostsPageQuery` in Api.ts for why this is a cursor rather than an offset.
// Posts are never reordered by edits, so the last row's id alone is enough
// (no tie-breaker column needed, unlike `listChats`'s cursor).
const encodePostsCursor = (id: number): string =>
  Buffer.from(String(id)).toString("base64url");

const decodePostsCursor = (cursor: string): number | null => {
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

export const PostsHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "posts",
  (handlers) =>
    handlers
      .handle("getPost", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const row = yield* getPostOr404(id);
          const like = yield* Effect.tryPromise(() =>
            postLikeInfo(db, [row.id], currentUser.id),
          ).pipe(Effect.orDie);
          return toApiPost(row, like.get(row.id));
        }),
      )
      .handle("listPosts", ({ urlParams }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const limit = urlParams.limit ?? DEFAULT_POSTS_LIMIT;

          let after: number | null = null;
          if (urlParams.cursor !== undefined) {
            after = decodePostsCursor(urlParams.cursor);
            if (after === null)
              return yield* Effect.fail(
                new InvalidPostsRequest({ message: "Invalid cursor" }),
              );
          }

          // Fetch one row past `limit` instead of firing a separate
          // `COUNT(*)` — whether that extra row came back is all
          // `nextCursor` needs, and unlike a full-table count this stays
          // cheap no matter how large `posts` grows (issue #51).
          const fetched = yield* Effect.tryPromise(() =>
            db
              .select()
              .from(posts)
              .where(after !== null ? lt(posts.id, after) : undefined)
              .orderBy(desc(posts.id))
              .limit(limit + 1),
          ).pipe(Effect.orDie);
          const hasMore = fetched.length > limit;
          const rows = fetched.slice(0, limit);
          const lastRow = rows[rows.length - 1];
          const nextCursor =
            hasMore && lastRow ? encodePostsCursor(lastRow.id) : null;
          const likeInfo = yield* Effect.tryPromise(() =>
            postLikeInfo(
              db,
              rows.map((r) => r.id),
              currentUser.id,
            ),
          ).pipe(Effect.orDie);
          return {
            posts: rows.map((r) => toApiPost(r, likeInfo.get(r.id))),
            limit,
            nextCursor,
          };
        }),
      )
      .handle("createPost", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          // Set both from a single Date rather than relying on the schema's
          // independent per-column $defaultFn — two separate `new Date()`
          // calls can land a millisecond apart, and a freshly created post's
          // createdAt/updatedAt should be identical, not just close.
          const now = new Date();
          const rows = yield* Effect.tryPromise(() =>
            db
              .insert(posts)
              .values({
                authorId: currentUser.id,
                contentType: payload.contentType,
                content: payload.content,
                createdAt: now,
                updatedAt: now,
              })
              .returning(),
          ).pipe(Effect.orDie);
          const row = rows[0];
          if (!row)
            return yield* Effect.die(new Error("INSERT returned no rows"));
          yield* Metric.update(
            Metric.taggedWithLabels(contentCreatedTotal, [
              MetricLabel.make("type", "post"),
            ]),
            1,
          );
          yield* connections.broadcastAll({
            type: "post_changed",
            postId: row.id,
          });
          return toApiPost(row);
        }),
      )
      .handle("updatePost", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const existing = yield* getPostOr404(id);
          if (!canModify(currentUser, existing))
            return yield* Effect.fail(
              new Forbidden({ message: "You can only edit your own posts" }),
            );

          const rows = yield* Effect.tryPromise(() =>
            db
              .update(posts)
              .set({
                contentType: payload.contentType,
                content: payload.content,
                updatedAt: new Date(),
              })
              .where(eq(posts.id, id))
              .returning(),
          ).pipe(Effect.orDie);
          const row = rows[0];
          if (!row)
            return yield* Effect.die(new Error("UPDATE returned no rows"));
          // Editing a post's content leaves its likes untouched — reflect the
          // existing count/likedByMe in the response rather than resetting it.
          const like = yield* Effect.tryPromise(() =>
            postLikeInfo(db, [row.id], currentUser.id),
          ).pipe(Effect.orDie);
          yield* connections.broadcastAll({
            type: "post_changed",
            postId: row.id,
          });
          return toApiPost(row, like.get(row.id));
        }),
      )
      .handle("deletePost", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const existing = yield* getPostOr404(id);
          if (!canModify(currentUser, existing))
            return yield* Effect.fail(
              new Forbidden({
                message: "You can only delete your own posts",
              }),
            );

          yield* Effect.tryPromise(() =>
            db.delete(posts).where(eq(posts.id, id)),
          ).pipe(Effect.orDie);
          yield* connections.broadcastAll({ type: "post_changed", postId: id });
        }),
      ),
);
