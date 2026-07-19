import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { type Attachment, NotFound } from "./Api.ts";
import { AttachmentStorage } from "./AttachmentStorage.ts";
import type { DrizzleDb } from "./Db.ts";
import { attachments, type DbAttachment } from "./db/schema.ts";

// Shared by ChatsHandler and PostsHandler — both messages and posts attach
// (at most) one row from the same `attachments` table (see db/schema.ts),
// so the "look up the row, mint a fresh presigned URL" logic lives here
// once rather than twice.

export const toApiAttachment = (
  row: DbAttachment,
  url: string,
): Attachment => ({
  id: row.id,
  filename: row.filename,
  mimeType: row.mimeType,
  size: row.size,
  url,
  width: row.width,
  height: row.height,
  blurhash: row.blurhash,
});

// A message/post's `attachmentId` is nullable — resolves to `null` both when
// unset and when the referenced row is somehow gone (shouldn't happen since
// the FK is `set null` on delete, but a message/post fetched in the same
// transaction as a concurrent attachment delete could still observe a
// dangling id momentarily).
export const resolveAttachment = (
  db: DrizzleDb,
  attachmentId: number | null,
): Effect.Effect<Attachment | null, never, AttachmentStorage> =>
  Effect.gen(function* () {
    if (attachmentId === null) return null;
    const storage = yield* AttachmentStorage;
    const rows = yield* Effect.tryPromise(() =>
      db
        .select()
        .from(attachments)
        .where(eq(attachments.id, attachmentId))
        .limit(1),
    ).pipe(Effect.orDie);
    const row = rows[0];
    if (!row) return null;
    return toApiAttachment(row, storage.presignGetUrl(row.storageKey));
  });

// Batched equivalent for building many messages/posts at once (listMessages,
// listPosts, getLastMessagesForChats) — one query across every referenced
// attachment id instead of one per row, mirroring reactions.ts's
// postReactionInfo/commentReactionInfo.
export const resolveAttachments = (
  db: DrizzleDb,
  attachmentIds: ReadonlyArray<number | null>,
): Effect.Effect<Map<number, Attachment>, never, AttachmentStorage> =>
  Effect.gen(function* () {
    const result = new Map<number, Attachment>();
    const ids = [
      ...new Set(attachmentIds.filter((id): id is number => id !== null)),
    ];
    if (ids.length === 0) return result;
    const storage = yield* AttachmentStorage;
    const rows = yield* Effect.tryPromise(() =>
      db.select().from(attachments).where(inArray(attachments.id, ids)),
    ).pipe(Effect.orDie);
    for (const row of rows) {
      result.set(
        row.id,
        toApiAttachment(row, storage.presignGetUrl(row.storageKey)),
      );
    }
    return result;
  });

// Looks up an attachment for use as a *new* message/post's attachmentId —
// requires it to exist and belong to the caller, so one user can't attach
// another's upload to their own message/post by guessing an id. Folds
// "doesn't exist" and "exists but isn't mine" into the same 404 (rather than
// a 403) to avoid confirming other users' attachment ids exist at all.
export const getOwnedAttachmentOr404 = (
  db: DrizzleDb,
  attachmentId: number,
  uploaderId: number,
): Effect.Effect<DbAttachment, NotFound> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      db
        .select()
        .from(attachments)
        .where(eq(attachments.id, attachmentId))
        .limit(1),
    ).pipe(Effect.orDie);
    const row = rows[0];
    if (!row || row.uploaderId !== uploaderId)
      return yield* Effect.fail(
        new NotFound({ message: `Attachment ${attachmentId} not found` }),
      );
    return row;
  });
