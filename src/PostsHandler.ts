import { HttpApiBuilder } from "effect/http-api";
import { and, desc, eq, lt, notInArray } from "drizzle-orm";
import { Effect, Metric } from "effect";
import {
  ChatApi,
  DEFAULT_POSTS_LIMIT,
  Forbidden,
  InvalidPostsRequest,
  NotFound,
} from "./Api.ts";
import {
  resolveAttachments,
  toApiAttachment,
  withClaimedAttachment,
} from "./attachments.ts";
import { AttachmentStorage } from "./AttachmentStorage.ts";
import { CurrentUser } from "./Auth.ts";
import { loadAuthor } from "./authors.ts";
import { hiddenAuthorIds, isHiddenFrom, type Viewer } from "./blocks.ts";
import { Db, type DrizzleDb, dbQuery } from "./Db.ts";
import { contentCreatedTotal } from "./Metrics.ts";
import { notifyMentions } from "./notifications.ts";
import { postReactionInfo } from "./reactions.ts";
import { RealtimeConnections } from "./Realtime.ts";
import { type DbPost, posts } from "./db/schema.ts";
import {
  NO_REACTIONS,
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

const getPostOr404 = (db: DrizzleDb, id: number) =>
  Effect.gen(function* () {
    const rows = yield* dbQuery(() =>
      db.select().from(posts).where(eq(posts.id, id)).limit(1),
    );
    const row = rows[0];
    if (!row)
      return yield* Effect.fail(
        new NotFound({ message: `Post ${id} not found` }),
      );
    return row;
  });

// Also 404s on a post whose author blocked `viewer` (issue #901).
const getVisiblePostOr404 = (db: DrizzleDb, viewer: Viewer, id: number) =>
  Effect.gen(function* () {
    const row = yield* getPostOr404(db, id);
    if (yield* dbQuery(() => isHiddenFrom(db, viewer, [row.authorId])))
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

// The full API view of a stored post as `viewer` sees it — its reactions,
// comment count (see `hiddenAuthorIds`) and attachment.
const buildPostResponse = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  row: DbPost,
  viewer: Viewer,
) =>
  Effect.gen(function* () {
    const author = yield* loadPostAuthor(db, row);
    const reactions = yield* dbQuery(() =>
      postReactionInfo(db, [row.id], viewer.id),
    );
    const commentCounts = yield* dbQuery(async () =>
      postCommentCounts(db, [row.id], await hiddenAuthorIds(db, viewer)),
    );
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
  dbQuery(() =>
    db
      .select()
      .from(posts)
      .where(and(eq(posts.authorId, authorId), eq(posts.clientId, clientId)))
      .limit(1),
  ).pipe(Effect.map((rows) => rows[0]));

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
          const row = yield* getVisiblePostOr404(db, currentUser, id);
          return yield* buildPostResponse(db, storage, row, currentUser);
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

          // Posts by users the viewer has blocked or muted (issue #219), or
          // who blocked the viewer (issue #901), are hidden. Kept as a `NOT IN` filter alongside the keyset
          // cursor rather than post-filtering the page, so a page never comes
          // back short after excluding a blocked author's posts.
          const hiddenIds = yield* dbQuery(() =>
            hiddenAuthorIds(db, currentUser),
          );

          // Fetch one row past `limit` instead of firing a separate
          // `COUNT(*)` — whether that extra row came back is all
          // `nextCursor` needs, and unlike a full-table count this stays
          // cheap no matter how large `posts` grows (issue #51).
          const fetched = yield* dbQuery(() =>
            db
              .select()
              .from(posts)
              .where(
                and(
                  after !== null ? lt(posts.id, after) : undefined,
                  hiddenIds.length > 0
                    ? notInArray(posts.authorId, hiddenIds)
                    : undefined,
                ),
              )
              .orderBy(desc(posts.id))
              .limit(limit + 1),
          );
          const hasMore = fetched.length > limit;
          const page = fetched.slice(0, limit);
          const lastRow = page[page.length - 1];
          const nextCursor =
            hasMore && lastRow ? encodePostsCursor(lastRow.id) : null;
          const authored = yield* withAuthors(db, page);
          const rows = authored.map((a) => a.row);
          const reactionInfo = yield* dbQuery(() =>
            postReactionInfo(
              db,
              rows.map((r) => r.id),
              currentUser.id,
            ),
          );
          const commentCounts = yield* dbQuery(() =>
            postCommentCounts(
              db,
              rows.map((r) => r.id),
              hiddenIds,
            ),
          );
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
                currentUser,
              );
          }

          // Set both from a single Date rather than relying on the schema's
          // independent per-column $defaultFn — two separate `new Date()`
          // calls can land a millisecond apart, and a freshly created post's
          // createdAt/updatedAt should be identical, not just close.
          const now = new Date();
          const { clientId } = payload;
          // A concurrent create of the same key that won the race has the
          // attachment by now, so only a claim it didn't make is a conflict.
          const claimed = yield* withClaimedAttachment(
            db,
            payload.attachmentId,
            currentUser.id,
            async (tx) =>
              (
                await tx
                  .insert(posts)
                  .values({
                    authorId: currentUser.id,
                    body: payload.body,
                    attachmentId: payload.attachmentId ?? null,
                    clientId: payload.clientId ?? null,
                    createdAt: now,
                    updatedAt: now,
                  })
                  .onConflictDoNothing()
                  .returning()
              )[0],
          ).pipe(
            Effect.catchTag("AttachmentInUse", (error) =>
              Effect.gen(function* () {
                const stored =
                  clientId === undefined
                    ? undefined
                    : yield* findPostByClientId(db, currentUser.id, clientId);
                if (!stored) return yield* Effect.fail(error);
                return { result: undefined, attachment: null };
              }),
            ),
          );
          const row = claimed.result;
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
                currentUser,
              );
          }
          if (!row)
            return yield* Effect.die(new Error("INSERT returned no rows"));
          const attachment = claimed.attachment
            ? toApiAttachment(
                claimed.attachment,
                storage.presignGetUrl(claimed.attachment.storageKey),
              )
            : null;
          yield* Metric.update(
            Metric.withAttributes(contentCreatedTotal, { type: "post" }),
            1,
          );
          // Coalesced into feed viewers' next `feed_head`, not broadcast
          // (issue #827; see FeedHeadEvent in Realtime.ts).
          yield* connections.announcePost(row.id);
          yield* notifyMentions(
            { db, connections },
            {
              actorId: currentUser.id,
              content: row.body,
              postId: row.id,
            },
          );
          const author = yield* loadPostAuthor(db, row);
          return toApiPost(row, author, NO_REACTIONS, attachment);
        }),
      )
      .handle("updatePost", ({ params: { id }, payload }) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser;
          const existing = yield* getVisiblePostOr404(db, currentUser, id);
          if (!canModify(currentUser, existing))
            return yield* Effect.fail(
              new Forbidden({ message: "You can only edit your own posts" }),
            );

          const claimed = yield* withClaimedAttachment(
            db,
            payload.attachmentId,
            currentUser.id,
            async (tx) =>
              (
                await tx
                  .update(posts)
                  .set({
                    body: payload.body,
                    attachmentId: payload.attachmentId ?? null,
                    updatedAt: new Date(),
                  })
                  .where(eq(posts.id, id))
                  .returning()
              )[0],
            async (tx) => {
              const current = await tx
                .select({ attachmentId: posts.attachmentId })
                .from(posts)
                .where(eq(posts.id, id))
                .for("update");
              return current[0]?.attachmentId ?? null;
            },
          );
          const row = claimed.result;
          const attachment = claimed.attachment
            ? toApiAttachment(
                claimed.attachment,
                storage.presignGetUrl(claimed.attachment.storageKey),
              )
            : null;

          if (!row)
            return yield* Effect.die(new Error("UPDATE returned no rows"));
          // Editing a post's content leaves its reactions and comments
          // untouched — reflect the existing state in the response rather than
          // resetting it.
          const reactions = yield* dbQuery(() =>
            postReactionInfo(db, [row.id], currentUser.id),
          );
          const commentCounts = yield* dbQuery(async () =>
            postCommentCounts(
              db,
              [row.id],
              await hiddenAuthorIds(db, currentUser),
            ),
          );
          // Only to the sockets showing the post (issue #828).
          yield* connections.notifyPostViewers(row.id, {
            type: "post_changed",
            postId: row.id,
            change: "updated",
          });
          // Only names this edit added are pinged (see notifyMentions).
          yield* notifyMentions(
            { db, connections },
            {
              actorId: row.authorId,
              content: row.body,
              previousContent: existing.body,
              postId: row.id,
            },
          );
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
          const existing = yield* getVisiblePostOr404(db, currentUser, id);
          if (!canModify(currentUser, existing))
            return yield* Effect.fail(
              new Forbidden({
                message: "You can only delete your own posts",
              }),
            );

          yield* dbQuery(() => db.delete(posts).where(eq(posts.id, id)));
          yield* connections.notifyPostViewers(id, {
            type: "post_changed",
            postId: id,
            change: "deleted",
          });
        }),
      );
  }),
);
