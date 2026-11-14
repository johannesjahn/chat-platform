import { HttpApiBuilder } from "effect/http-api";
import { and, desc, eq, lt, notInArray } from "drizzle-orm";
import { Effect, Metric } from "effect";
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
import { loadAuthor } from "./authors.ts";
import { blockedOrMutedUserIds } from "./blocks.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { contentCreatedTotal } from "./Metrics.ts";
import { notifyMentions } from "./notifications.ts";
import { postReactionInfo } from "./reactions.ts";
import { RealtimeConnections } from "./Realtime.ts";
import { type DbPost, posts } from "./db/schema.ts";
import {
  NO_REACTIONS,
  captionOf,
  decodePostsCursor,
  encodePostsCursor,
  postCommentCounts,
  toApiPost,
  withAuthors,
} from "./posts.ts";

// Admins can edit/delete any post; everyone else only their own.
const canModify = (
  currentUser: { readonly id: number; readonly role: string },
  post: { readonly authorId: number },
): boolean => currentUser.role === "admin" || post.authorId === currentUser.id;

// The part of a post that's prose and so can carry `@mentions`: a "text"
// post's content, or an "attachment" post's caption (issue #765) — both are
// rendered as text, with mentions linked (see PostCard.tsx). An "image_url"
// post's content and an attachment's filename are never shown as prose.
const mentionText = (row: {
  readonly contentType: string;
  readonly content: string;
  readonly caption: string | null;
}): string | undefined =>
  row.contentType === "text" ? row.content : (captionOf(row) ?? undefined);

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

// A post whose author vanished mid-request is being cascade-deleted with
// them, so it reads as gone (see authors.ts).
const loadPostAuthor = (db: DrizzleDb, row: DbPost) =>
  loadAuthor(
    db,
    row.authorId,
    () => new NotFound({ message: `Post ${row.id} not found` }),
  );

// The full API view of a stored post as `viewerId` sees it — its reactions,
// comment count (hiding authors the viewer blocked/muted) and attachment.
const buildPostResponse = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  row: DbPost,
  viewerId: number,
) =>
  Effect.gen(function* () {
    const author = yield* loadPostAuthor(db, row);
    const reactions = yield* Effect.tryPromise(() =>
      postReactionInfo(db, [row.id], viewerId),
    ).pipe(Effect.orDie);
    const commentCounts = yield* Effect.tryPromise(async () =>
      postCommentCounts(
        db,
        [row.id],
        await blockedOrMutedUserIds(db, viewerId),
      ),
    ).pipe(Effect.orDie);
    const attachments = yield* resolveAttachments(db, storage, [
      row.attachmentId,
    ]);
    return toApiPost(
      row,
      author,
      reactions.get(row.id),
      row.attachmentId !== null
        ? (attachments.get(row.attachmentId) ?? null)
        : null,
      commentCounts.get(row.id) ?? 0,
    );
  });

// The post this author already created under the idempotency key `clientId`
// (issue #657), if any.
const findPostByClientId = (
  db: DrizzleDb,
  authorId: number,
  clientId: string,
): Effect.Effect<DbPost | undefined> =>
  Effect.tryPromise(() =>
    db
      .select()
      .from(posts)
      .where(and(eq(posts.authorId, authorId), eq(posts.clientId, clientId)))
      .limit(1),
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]),
  );

export const PostsHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "posts",
  Effect.fn(function* (handlers) {
    const db = yield* Db;
    const storage = yield* AttachmentStorage;
    const connections = yield* RealtimeConnections;
    return handlers
      .handle("getPost", ({ params: { id } }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const row = yield* getPostOr404(db, id);
          return yield* buildPostResponse(db, storage, row, currentUser.id);
        }),
      )
      .handle("listPosts", ({ query: urlParams }) =>
        Effect.gen(function* () {
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
          const page = fetched.slice(0, limit);
          const lastRow = page[page.length - 1];
          const nextCursor =
            hasMore && lastRow ? encodePostsCursor(lastRow.id) : null;
          const authored = yield* withAuthors(db, page);
          const rows = authored.map((a) => a.row);
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
              hiddenAuthorIds,
            ),
          ).pipe(Effect.orDie);
          const attachments = yield* resolveAttachments(
            db,
            storage,
            rows.map((r) => r.attachmentId),
          );
          return {
            posts: authored.map(({ row: r, author }) =>
              toApiPost(
                r,
                author,
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
          const currentUser = yield* CurrentUser;

          // A repeat of a create the server already stored (issue #657) —
          // e.g. the response was lost and the offline queue replayed it —
          // returns the original post untouched: no second row, no second
          // broadcast or mention notification.
          if (payload.clientId !== undefined) {
            const existing = yield* findPostByClientId(
              db,
              currentUser.id,
              payload.clientId,
            );
            if (existing)
              return yield* buildPostResponse(
                db,
                storage,
                existing,
                currentUser.id,
              );
          }

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
                caption: payload.caption ?? null,
                clientId: payload.clientId ?? null,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoNothing()
              .returning(),
          ).pipe(Effect.orDie);
          const row = rows[0];
          if (!row && payload.clientId !== undefined) {
            // Lost a race with a concurrent create of the same key.
            const existing = yield* findPostByClientId(
              db,
              currentUser.id,
              payload.clientId,
            );
            if (existing)
              return yield* buildPostResponse(
                db,
                storage,
                existing,
                currentUser.id,
              );
          }
          if (!row)
            return yield* Effect.die(new Error("INSERT returned no rows"));
          yield* Metric.update(
            Metric.withAttributes(contentCreatedTotal, { type: "post" }),
            1,
          );
          yield* connections.broadcastAll({
            type: "post_changed",
            postId: row.id,
            change: "created",
          });
          const mentions = mentionText(row);
          if (mentions !== undefined) {
            yield* notifyMentions(
              { db, connections },
              {
                actorId: currentUser.id,
                content: mentions,
                postId: row.id,
              },
            );
          }
          const author = yield* loadPostAuthor(db, row);
          return toApiPost(row, author, NO_REACTIONS, attachment);
        }),
      )
      .handle("updatePost", ({ params: { id }, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const existing = yield* getPostOr404(db, id);
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
                // Omitted keeps the current caption (see `UpdatePostBody`);
                // only an attachment carries one.
                caption:
                  payload.contentType !== "attachment"
                    ? null
                    : payload.caption === undefined
                      ? captionOf(existing)
                      : payload.caption,
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
          const commentCounts = yield* Effect.tryPromise(async () =>
            postCommentCounts(
              db,
              [row.id],
              await blockedOrMutedUserIds(db, currentUser.id),
            ),
          ).pipe(Effect.orDie);
          yield* connections.broadcastAll({
            type: "post_changed",
            postId: row.id,
            change: "updated",
          });
          // Only names this edit added are pinged (see notifyMentions).
          const mentions = mentionText(row);
          if (mentions !== undefined) {
            yield* notifyMentions(
              { db, connections },
              {
                actorId: row.authorId,
                content: mentions,
                previousContent: mentionText(existing),
                postId: row.id,
              },
            );
          }
          const author = yield* loadPostAuthor(db, row);
          return toApiPost(
            row,
            author,
            reactions.get(row.id),
            attachment,
            commentCounts.get(row.id) ?? 0,
          );
        }),
      )
      .handle("deletePost", ({ params: { id } }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const existing = yield* getPostOr404(db, id);
          if (!canModify(currentUser, existing))
            return yield* Effect.fail(
              new Forbidden({
                message: "You can only delete your own posts",
              }),
            );

          yield* Effect.tryPromise(() =>
            db.delete(posts).where(eq(posts.id, id)),
          ).pipe(Effect.orDie);
          yield* connections.broadcastAll({
            type: "post_changed",
            postId: id,
            change: "deleted",
          });
        }),
      );
  }),
);
