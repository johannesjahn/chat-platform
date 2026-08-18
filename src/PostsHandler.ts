import { HttpApiBuilder } from "@effect/platform";
import { and, count, desc, eq, inArray, lt, notInArray } from "drizzle-orm";
import { Effect, Metric, MetricLabel } from "effect";
import {
  type Attachment,
  ChatApi,
  DEFAULT_POSTS_LIMIT,
  Forbidden,
  InvalidPostsRequest,
  NotFound,
} from "./Api.ts";
import {
  getOwnedAttachmentOr404,
  resolveAttachments,
  toApiAttachment,
} from "./attachments.ts";
import { AttachmentStorage } from "./AttachmentStorage.ts";
import { CurrentUser } from "./Auth.ts";
import { blockedOrMutedUserIds } from "./blocks.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { contentCreatedTotal } from "./Metrics.ts";
import { postReactionInfo, type ReactionSummary } from "./reactions.ts";
import { RealtimeConnections } from "./Realtime.ts";
import { comments, posts } from "./db/schema.ts";

const NO_REACTIONS: ReactionSummary[] = [];

export const toApiPost = (
  row: typeof posts.$inferSelect,
  reactions: ReadonlyArray<ReactionSummary> = NO_REACTIONS,
  attachment: Attachment | null = null,
  commentCount = 0,
) => ({
  id: row.id,
  authorId: row.authorId,
  contentType: row.contentType,
  content: row.content,
  attachment,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  reactions: [...reactions],
  commentCount,
});

// Total comments (top-level *and* replies) per post for a batch of ids, in one
// grouped COUNT over `comments` — mirrors `postReactionInfo`'s shape/rationale
// (computed on read, not stored — see reactions.ts and the `commentCount`
// comment on `Post` in Api.ts). The `comments_post_id_idx` (postId, id) index
// keeps a page's worth cheap. Ids with no comments are simply absent from the
// map; callers default them to 0.
export const postCommentCounts = async (
  db: DrizzleDb,
  postIds: ReadonlyArray<number>,
): Promise<Map<number, number>> => {
  const result = new Map<number, number>();
  if (postIds.length === 0) return result;
  const rows = await db
    .select({ postId: comments.postId, total: count() })
    .from(comments)
    .where(inArray(comments.postId, [...postIds]))
    .groupBy(comments.postId);
  for (const row of rows) result.set(row.postId, Number(row.total));
  return result;
};

// Admins can edit/delete any post; everyone else only their own.
const canModify = (
  currentUser: { readonly id: number; readonly role: string },
  post: { readonly authorId: number },
): boolean => currentUser.role === "admin" || post.authorId === currentUser.id;

// Keyset cursor for `listPosts` over its `id desc` sort — see
// `PostsPageQuery` in Api.ts for why this is a cursor rather than an offset.
// Posts are never reordered by edits, so the last row's id alone is enough
// (no tie-breaker column needed, unlike `listChats`'s cursor). Exported —
// `listUserPosts` in UsersHandler.ts shares the same cursor format since it
// sorts posts the same way, just pre-filtered to one author.
export const encodePostsCursor = (id: number): string =>
  Buffer.from(String(id)).toString("base64url");

export const decodePostsCursor = (cursor: string): number | null => {
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
          const reactions = yield* Effect.tryPromise(() =>
            postReactionInfo(db, [row.id], currentUser.id),
          ).pipe(Effect.orDie);
          const commentCounts = yield* Effect.tryPromise(() =>
            postCommentCounts(db, [row.id]),
          ).pipe(Effect.orDie);
          const attachments = yield* resolveAttachments(db, [row.attachmentId]);
          return toApiPost(
            row,
            reactions.get(row.id),
            row.attachmentId !== null
              ? (attachments.get(row.attachmentId) ?? null)
              : null,
            commentCounts.get(row.id) ?? 0,
          );
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

          // Posts by users the viewer has blocked or muted are hidden from
          // the feed (issue #219) — both actions hide posts, so this doesn't
          // distinguish them. Kept as a `NOT IN` filter alongside the keyset
          // cursor rather than post-filtering the page, so a page never comes
          // back short after excluding a blocked author's posts.
          const hiddenAuthorIds = yield* Effect.tryPromise(() =>
            blockedOrMutedUserIds(db, currentUser.id),
          ).pipe(Effect.orDie);

          // Fetch one row past `limit` instead of firing a separate
          // `COUNT(*)` — whether that extra row came back is all
          // `nextCursor` needs, and unlike a full-table count this stays
          // cheap no matter how large `posts` grows (issue #51).
          const fetched = yield* Effect.tryPromise(() =>
            db
              .select()
              .from(posts)
              .where(
                and(
                  after !== null ? lt(posts.id, after) : undefined,
                  hiddenAuthorIds.length > 0
                    ? notInArray(posts.authorId, hiddenAuthorIds)
                    : undefined,
                ),
              )
              .orderBy(desc(posts.id))
              .limit(limit + 1),
          ).pipe(Effect.orDie);
          const hasMore = fetched.length > limit;
          const rows = fetched.slice(0, limit);
          const lastRow = rows[rows.length - 1];
          const nextCursor =
            hasMore && lastRow ? encodePostsCursor(lastRow.id) : null;
          const reactionInfo = yield* Effect.tryPromise(() =>
            postReactionInfo(
              db,
              rows.map((r) => r.id),
              currentUser.id,
            ),
          ).pipe(Effect.orDie);
          const commentCounts = yield* Effect.tryPromise(() =>
            postCommentCounts(
              db,
              rows.map((r) => r.id),
            ),
          ).pipe(Effect.orDie);
          const attachments = yield* resolveAttachments(
            db,
            rows.map((r) => r.attachmentId),
          );
          return {
            posts: rows.map((r) =>
              toApiPost(
                r,
                reactionInfo.get(r.id),
                r.attachmentId !== null
                  ? (attachments.get(r.attachmentId) ?? null)
                  : null,
                commentCounts.get(r.id) ?? 0,
              ),
            ),
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
          const storage = yield* AttachmentStorage;

          let attachment: Attachment | null = null;
          if (payload.attachmentId !== undefined) {
            const attachmentRow = yield* getOwnedAttachmentOr404(
              db,
              payload.attachmentId,
              currentUser.id,
            );
            attachment = toApiAttachment(
              attachmentRow,
              storage.presignGetUrl(attachmentRow.storageKey),
            );
          }

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
                attachmentId: payload.attachmentId ?? null,
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
          return toApiPost(row, NO_REACTIONS, attachment);
        }),
      )
      .handle("updatePost", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const storage = yield* AttachmentStorage;
          const existing = yield* getPostOr404(id);
          if (!canModify(currentUser, existing))
            return yield* Effect.fail(
              new Forbidden({ message: "You can only edit your own posts" }),
            );

          let attachment: Attachment | null = null;
          if (payload.attachmentId !== undefined) {
            const attachmentRow = yield* getOwnedAttachmentOr404(
              db,
              payload.attachmentId,
              currentUser.id,
            );
            attachment = toApiAttachment(
              attachmentRow,
              storage.presignGetUrl(attachmentRow.storageKey),
            );
          }

          const rows = yield* Effect.tryPromise(() =>
            db
              .update(posts)
              .set({
                contentType: payload.contentType,
                content: payload.content,
                attachmentId: payload.attachmentId ?? null,
                updatedAt: new Date(),
              })
              .where(eq(posts.id, id))
              .returning(),
          ).pipe(Effect.orDie);
          const row = rows[0];
          if (!row)
            return yield* Effect.die(new Error("UPDATE returned no rows"));
          // Editing a post's content leaves its reactions and comments
          // untouched — reflect the existing state in the response rather than
          // resetting it.
          const reactions = yield* Effect.tryPromise(() =>
            postReactionInfo(db, [row.id], currentUser.id),
          ).pipe(Effect.orDie);
          const commentCounts = yield* Effect.tryPromise(() =>
            postCommentCounts(db, [row.id]),
          ).pipe(Effect.orDie);
          yield* connections.broadcastAll({
            type: "post_changed",
            postId: row.id,
          });
          return toApiPost(
            row,
            reactions.get(row.id),
            attachment,
            commentCounts.get(row.id) ?? 0,
          );
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
