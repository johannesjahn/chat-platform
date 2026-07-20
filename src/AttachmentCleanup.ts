import { and, eq, isNotNull, lt, notInArray } from "drizzle-orm";
import { Duration, Effect, Layer, Schedule } from "effect";
import { AttachmentStorage } from "./AttachmentStorage.ts";
import { Db } from "./Db.ts";
import { attachments, messages, posts } from "./db/schema.ts";

// An attachment (issue #221) uploaded via `POST /attachments` but never
// referenced by a message/post's `attachmentId` (the caller abandoned the
// upload, or never sent the follow-up createMessage/createPost) has nothing
// pointing at it and nothing else will ever remove it — the row/object
// would otherwise sit in the table/bucket forever (issue #256). This
// mirrors RefreshTokenCleanup.ts's shape: reclaim rows nothing references
// instead of letting them accumulate without bound.
//
// The grace period exists so an attachment in the (normally brief) window
// between a successful upload and the follow-up create call that attaches
// it isn't swept out from under the caller.
const ORPHAN_GRACE_PERIOD = Duration.hours(24);

export const cleanupOrphanedAttachments: Effect.Effect<
  void,
  never,
  Db | AttachmentStorage
> = Effect.gen(function* () {
  const db = yield* Db;
  const storage = yield* AttachmentStorage;
  const cutoff = new Date(Date.now() - Duration.toMillis(ORPHAN_GRACE_PERIOD));

  const orphaned = yield* Effect.tryPromise(() =>
    db
      .select({ id: attachments.id, storageKey: attachments.storageKey })
      .from(attachments)
      .where(
        and(
          lt(attachments.createdAt, cutoff),
          notInArray(
            attachments.id,
            db
              .select({ id: messages.attachmentId })
              .from(messages)
              .where(isNotNull(messages.attachmentId)),
          ),
          notInArray(
            attachments.id,
            db
              .select({ id: posts.attachmentId })
              .from(posts)
              .where(isNotNull(posts.attachmentId)),
          ),
        ),
      ),
  ).pipe(Effect.orDie);

  for (const row of orphaned) {
    // Best-effort: a failed bucket delete shouldn't stop the row (and thus
    // the user's quota usage, see AttachmentsHandler.ts) from being
    // reclaimed, nor kill the repeating background fiber below — it just
    // leaves an unreferenced object behind in the bucket, the lesser of the
    // two problems.
    yield* storage
      .delete(row.storageKey)
      .pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning(
            "AttachmentCleanup: failed to delete orphaned attachment from storage",
          ).pipe(Effect.annotateLogs({ storageKey: row.storageKey, cause })),
        ),
      );
    yield* Effect.tryPromise(() =>
      db.delete(attachments).where(eq(attachments.id, row.id)),
    ).pipe(Effect.orDie);
  }
});

const CLEANUP_INTERVAL = Duration.hours(1);

// Runs cleanupOrphanedAttachments once at startup and then every
// CLEANUP_INTERVAL for as long as the layer stays built, as a background
// fiber tied to the layer's scope (interrupted on shutdown) — same shape as
// RefreshTokenCleanupLive.
export const AttachmentCleanupLive = Layer.scopedDiscard(
  Effect.forkScoped(
    cleanupOrphanedAttachments.pipe(
      Effect.repeat(Schedule.spaced(CLEANUP_INTERVAL)),
    ),
  ),
);
