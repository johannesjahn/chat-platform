import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { type Attachment, AttachmentQuotaExceeded, NotFound } from "./Api.ts";
import { AttachmentStorage } from "./AttachmentStorage.ts";
import { dbQuery, type DrizzleDb } from "./Db.ts";
import { attachments, type DbAttachment, users } from "./db/schema.ts";

// Shared by src/chats/ and PostsHandler — both messages and posts attach
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
  waveform: row.waveform,
  durationMs: row.durationMs,
});

// A message/post's `attachmentId` is nullable — resolves to `null` both when
// unset and when the referenced row is somehow gone (shouldn't happen since
// the FK is `set null` on delete, but a message/post fetched in the same
// transaction as a concurrent attachment delete could still observe a
// dangling id momentarily).
export const resolveAttachment = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  attachmentId: number | null,
): Effect.Effect<Attachment | null> =>
  Effect.gen(function* () {
    if (attachmentId === null) return null;
    const rows = yield* dbQuery(() =>
      db
        .select()
        .from(attachments)
        .where(eq(attachments.id, attachmentId))
        .limit(1),
    );
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
  storage: AttachmentStorage["Service"],
  attachmentIds: ReadonlyArray<number | null>,
): Effect.Effect<Map<number, Attachment>> =>
  Effect.gen(function* () {
    const result = new Map<number, Attachment>();
    const ids = [
      ...new Set(attachmentIds.filter((id): id is number => id !== null)),
    ];
    if (ids.length === 0) return result;
    const rows = yield* dbQuery(() =>
      db.select().from(attachments).where(inArray(attachments.id, ids)),
    );
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
    const rows = yield* dbQuery(() =>
      db
        .select()
        .from(attachments)
        .where(eq(attachments.id, attachmentId))
        .limit(1),
    );
    const row = rows[0];
    if (!row || row.uploaderId !== uploaderId)
      return yield* Effect.fail(
        new NotFound({ message: `Attachment ${attachmentId} not found` }),
      );
    return row;
  });

// Bounds total storage a single user can accumulate across every upload —
// unlike AttachmentsHandler.ts's enforceUploadLimit (velocity: uploads per
// minute) or MAX_ATTACHMENT_SIZE_BYTES (one file's size), nothing previously
// bounded how much a user could pile up over time by uploading steadily
// rather than in a burst (issue #256).
export const ATTACHMENT_QUOTA_MAX_BYTES = 500 * 1024 * 1024; // 500MB per user

// Exported for forwarding (chats/forwardHandlers.ts, issue #601): a forwarded
// attachment is copied into a new upload owned by the forwarder, which
// counts toward their quota like any other.
export const enforceUploadQuota = (
  db: DrizzleDb,
  userId: number,
  incomingSize: number,
) =>
  Effect.gen(function* () {
    // A single-row read of the running total a trigger on `attachments`
    // keeps up to date (migration 0033), rather than re-summing every
    // attachment the user has ever kept (issue #326).
    const rows = yield* dbQuery(() =>
      db
        .select({ storageUsedBytes: users.storageUsedBytes })
        .from(users)
        .where(eq(users.id, userId)),
    );
    const currentTotal = rows[0]?.storageUsedBytes ?? 0;
    if (currentTotal + incomingSize > ATTACHMENT_QUOTA_MAX_BYTES) {
      return yield* Effect.fail(
        new AttachmentQuotaExceeded({
          message: `Storage quota exceeded: uploads are capped at ${ATTACHMENT_QUOTA_MAX_BYTES} bytes per user`,
        }),
      );
    }
  });
