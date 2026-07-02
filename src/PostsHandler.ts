import { HttpApiBuilder } from "@effect/platform";
import { count, desc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { ChatApi, DEFAULT_POSTS_LIMIT, Forbidden, NotFound } from "./Api.ts";
import { CurrentUser } from "./Auth.ts";
import { Db } from "./Db.ts";
import { posts } from "./db/schema.ts";

const toApiPost = (row: typeof posts.$inferSelect) => ({
  id: row.id,
  authorId: row.authorId,
  contentType: row.contentType,
  content: row.content,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

// Admins can edit/delete any post; everyone else only their own.
const canModify = (
  currentUser: { readonly id: number; readonly role: string },
  post: { readonly authorId: number },
): boolean => currentUser.role === "admin" || post.authorId === currentUser.id;

const getPostOr404 = (id: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const rows = yield* Effect.try(() =>
      db.select().from(posts).where(eq(posts.id, id)).limit(1).all(),
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
      .handle("listPosts", () =>
        Effect.gen(function* () {
          const db = yield* Db;
          const rows = yield* Effect.try(() =>
            db.select().from(posts).orderBy(desc(posts.id)).all(),
          ).pipe(Effect.orDie);
          return rows.map(toApiPost);
        }),
      )
      .handle("getPost", ({ path: { id } }) =>
        Effect.gen(function* () {
          const row = yield* getPostOr404(id);
          return toApiPost(row);
        }),
      )
      .handle("listAllPosts", ({ urlParams }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const offset = urlParams.offset ?? 0;
          const limit = urlParams.limit ?? DEFAULT_POSTS_LIMIT;
          const rows = yield* Effect.try(() =>
            db
              .select()
              .from(posts)
              .orderBy(desc(posts.id))
              .limit(limit)
              .offset(offset)
              .all(),
          ).pipe(Effect.orDie);
          const totalRows = yield* Effect.try(() =>
            db.select({ total: count() }).from(posts).all(),
          ).pipe(Effect.orDie);
          const total = totalRows[0]?.total ?? 0;
          return { posts: rows.map(toApiPost), offset, limit, total };
        }),
      )
      .handle("createPost", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          // Set both from a single Date rather than relying on the schema's
          // independent per-column $defaultFn — two separate `new Date()`
          // calls can land a millisecond apart, and a freshly created post's
          // createdAt/updatedAt should be identical, not just close.
          const now = new Date();
          const rows = yield* Effect.try(() =>
            db
              .insert(posts)
              .values({
                authorId: currentUser.id,
                contentType: payload.contentType,
                content: payload.content,
                createdAt: now,
                updatedAt: now,
              })
              .returning()
              .all(),
          ).pipe(Effect.orDie);
          const row = rows[0];
          if (!row)
            return yield* Effect.die(new Error("INSERT returned no rows"));
          return toApiPost(row);
        }),
      )
      .handle("updatePost", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const existing = yield* getPostOr404(id);
          if (!canModify(currentUser, existing))
            return yield* Effect.fail(
              new Forbidden({ message: "You can only edit your own posts" }),
            );

          const rows = yield* Effect.try(() =>
            db
              .update(posts)
              .set({
                contentType: payload.contentType,
                content: payload.content,
                updatedAt: new Date(),
              })
              .where(eq(posts.id, id))
              .returning()
              .all(),
          ).pipe(Effect.orDie);
          const row = rows[0];
          if (!row)
            return yield* Effect.die(new Error("UPDATE returned no rows"));
          return toApiPost(row);
        }),
      )
      .handle("deletePost", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const existing = yield* getPostOr404(id);
          if (!canModify(currentUser, existing))
            return yield* Effect.fail(
              new Forbidden({
                message: "You can only delete your own posts",
              }),
            );

          yield* Effect.try(() =>
            db.delete(posts).where(eq(posts.id, id)).run(),
          ).pipe(Effect.orDie);
        }),
      ),
);
