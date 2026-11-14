import { and, eq, inArray } from "drizzle-orm";
import { Effect, Metric } from "effect";
import {
  type Attachment,
  NotFound,
  type ForwardFailureReason,
  type ForwardTargetResult,
  isAllowedImageUrl,
  type Message,
} from "../Api.ts";
import { toApiAttachment, enforceUploadQuota } from "../attachments.ts";

import { CurrentUser } from "../Auth.ts";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import { chargeGlobalRequests } from "../GlobalRateLimit.ts";
import { contentCreatedTotal } from "../Metrics.ts";
import {
  attachments,
  chats,
  messages,
  users,
  type DbAttachment,
  type DbMessage,
  type NewDbMessage,
} from "../db/schema.ts";
import { type ChatsDeps, type ChatsHandlers } from "./handlerKit.ts";
import {
  getMessageOr404,
  isAcceptedParticipant,
  isParticipant,
} from "./access.ts";
import {
  NO_REACTIONS,
  buildMessageResponse,
  messageCaption,
  toApiMessage,
} from "./messageViews.ts";
import {
  directChatBlocked,
  findMessageByClientId,
  insertMessage,
  publishNewMessage,
} from "./sendPath.ts";

// Source-side authorization for forwarding a message (issue #601): the
// caller must currently be in the chat, and the message must belong to it.
// A caller who isn't (or is no longer) in the chat gets the same 404 as for a
// message that doesn't exist, so ids from other people's chats aren't
// confirmed to exist. Every message a participant can see is forwardable
// today; a per-chat "restrict forwarding" setting would be checked here.
const getForwardableMessageOr404 = (
  db: DrizzleDb,
  chatId: number,
  messageId: number,
  userId: number,
): Effect.Effect<DbMessage, NotFound> =>
  Effect.gen(function* () {
    if (!(yield* isParticipant(db, chatId, userId)))
      return yield* Effect.fail(
        new NotFound({
          message: `Message ${messageId} not found in chat ${chatId}`,
        }),
      );
    return yield* getMessageOr404(db, chatId, messageId);
  });

export const forwardHandlers = ({
  db,
  storage,
  limiter,
  connections,
}: ChatsDeps) =>
  ({
    forwardMessage: ({ params: { id, messageId }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const source = yield* getForwardableMessageOr404(
          db,
          id,
          messageId,
          currentUser.id,
        );
        const targetIds = [...new Set(payload.targetChatIds)];

        // Who the label credits, snapshotted now so it survives renames
        // and deletions. A forward of a forward copies its attribution
        // through, crediting the original author rather than the
        // person in the middle — so chains never nest.
        let forwardedFrom: {
          forwardedFromMessageId: number | null;
          forwardedFromSenderId: number | null;
          forwardedFromSenderName: string;
        };
        if (source.forwardedFromSenderName !== null) {
          forwardedFrom = {
            forwardedFromMessageId: source.forwardedFromMessageId,
            forwardedFromSenderId: source.forwardedFromSenderId,
            forwardedFromSenderName: source.forwardedFromSenderName,
          };
        } else {
          const senders = yield* dbQuery(() =>
            db
              .select({
                displayName: users.displayName,
                username: users.username,
              })
              .from(users)
              .where(eq(users.id, source.senderId))
              .limit(1),
          );
          const sender = senders[0];
          forwardedFrom = {
            forwardedFromMessageId: source.id,
            forwardedFromSenderId: source.senderId,
            forwardedFromSenderName: sender
              ? (sender.displayName ?? sender.username)
              : "Unknown",
          };
        }

        // Content that can't be posted anywhere fails every target, not
        // the request: an image URL whose host has since left the
        // allowlist (the copy must still pass the check a fresh send
        // would), or an attachment that's no longer stored.
        let sourceAttachment: DbAttachment | null = null;
        let contentProblem: string | null = null;
        if (
          source.contentType === "image_url" &&
          !isAllowedImageUrl(source.content)
        ) {
          contentProblem = "This image's host is no longer allowed";
        } else if (source.contentType === "attachment") {
          const rows =
            source.attachmentId === null
              ? []
              : yield* dbQuery(() =>
                  db
                    .select()
                    .from(attachments)
                    .where(eq(attachments.id, source.attachmentId!))
                    .limit(1),
                );
          sourceAttachment = rows[0] ?? null;
          if (!sourceAttachment)
            contentProblem = "The attachment is no longer available";
        }

        // Copies a replayed forward already made (issue #567): each
        // target's copy is keyed `${clientId}:${targetId}`, so a retry
        // after a reload returns those and only fills in the rest.
        const keyFor = (targetId: number) =>
          payload.clientId !== undefined
            ? `${payload.clientId}:${targetId}`
            : null;
        const existingByChat = new Map<number, DbMessage>();
        if (payload.clientId !== undefined) {
          const keys = targetIds.map((t) => keyFor(t)!);
          const rows = yield* dbQuery(() =>
            db
              .select()
              .from(messages)
              .where(
                and(
                  eq(messages.senderId, currentUser.id),
                  inArray(messages.chatId, targetIds),
                  inArray(messages.clientId, keys),
                ),
              ),
          );
          for (const row of rows)
            if (row.clientId === keyFor(row.chatId))
              existingByChat.set(row.chatId, row);
        }

        // A forward to N chats is N sends: the request itself already
        // took one unit of the global per-IP budget, so charge the
        // rest — only for copies that still need making, so a replay
        // isn't billed twice.
        const toSend = targetIds.filter((t) => !existingByChat.has(t));
        yield* chargeGlobalRequests(limiter, toSend.length - 1);

        const failed = (
          chatId: number,
          reason: ForwardFailureReason,
          message: string,
        ): ForwardTargetResult => ({
          chatId,
          message: null,
          error: { reason, message },
        });
        const delivered = (
          chatId: number,
          message: Message,
        ): ForwardTargetResult => ({ chatId, message, error: null });

        const forwardInto = (
          targetId: number,
        ): Effect.Effect<ForwardTargetResult> =>
          Effect.gen(function* () {
            // Target-side authorization: the caller must be in every
            // chat they post into, so a former member can't post into a
            // group they've left — and must have accepted it, so a
            // message request can't be posted into either (issue #808).
            // A chat that doesn't exist reads the same as one they're not
            // in.
            const chatRows = yield* dbQuery(() =>
              db.select().from(chats).where(eq(chats.id, targetId)),
            );
            const chatRow = chatRows[0];
            if (
              !chatRow ||
              !(yield* isAcceptedParticipant(db, targetId, currentUser.id))
            )
              return failed(
                targetId,
                "unavailable",
                "You can't post in this chat",
              );

            const existing = existingByChat.get(targetId);
            if (existing)
              return delivered(
                targetId,
                yield* buildMessageResponse(
                  db,
                  storage,
                  existing,
                  currentUser.id,
                ),
              );

            if (yield* directChatBlocked(db, chatRow, currentUser.id))
              return failed(
                targetId,
                "blocked",
                "You can't send messages in this chat because of a block",
              );
            if (contentProblem !== null)
              return failed(targetId, "invalid_content", contentProblem);

            const clientId = keyFor(targetId);
            const now = new Date();
            // A copy, not a link: a forward never quotes (the parent is
            // in another chat — issue #217's same-chat rule), and starts
            // with no reactions, receipts, pins or stars of its own.
            const values = {
              chatId: targetId,
              senderId: currentUser.id,
              contentType: source.contentType,
              content: source.content,
              // The caption travels with its attachment (issue #765).
              caption: messageCaption(source),
              parentMessageId: null,
              clientId,
              ...forwardedFrom,
              createdAt: now,
              updatedAt: now,
            };

            let row: DbMessage | undefined;
            let attachment: Attachment | null = null;
            if (sourceAttachment) {
              const copied = yield* copyAttachmentForForward(
                sourceAttachment,
                values,
              );
              if ("error" in copied)
                return failed(targetId, copied.error, copied.message);
              row = copied.row;
              attachment = copied.attachment;
            } else {
              row = yield* dbQuery(() =>
                insertMessage(db, { ...values, attachmentId: null }),
              );
            }

            if (!row && clientId !== null) {
              // Lost a race with a concurrent replay of the same forward.
              const raced = yield* findMessageByClientId(
                db,
                targetId,
                currentUser.id,
                clientId,
              );
              if (raced)
                return delivered(
                  targetId,
                  yield* buildMessageResponse(
                    db,
                    storage,
                    raced,
                    currentUser.id,
                  ),
                );
            }
            if (!row)
              return yield* Effect.die(new Error("INSERT returned no rows"));

            yield* Metric.update(
              Metric.withAttributes(contentCreatedTotal, {
                type: "message",
                forwarded: "true",
              }),
              1,
            );
            yield* publishNewMessage(
              db,
              connections,
              targetId,
              currentUser.id,
              row.id,
            );
            return delivered(
              targetId,
              toApiMessage(
                row,
                [],
                attachment,
                NO_REACTIONS,
                null,
                false,
                false,
                currentUser.id,
              ),
            );
          });

        // A forwarded attachment gets its own upload, owned by the
        // forwarder: the "one message per attachment" invariant
        // (db/schema.ts) is what lets the original's uploader delete it
        // — or their account — without breaking anyone else's message,
        // and what the quota and orphan sweep assume. So the stored file
        // is copied, the copy counts toward the forwarder's quota, and
        // its row and the message land in one transaction. Whatever
        // step fails, nothing half-made is left behind: the sweep only
        // reclaims unreferenced rows after a day, and never objects
        // without a row at all.
        const copyAttachmentForForward = (
          original: DbAttachment,
          values: Omit<NewDbMessage, "attachmentId"> & {
            createdAt: Date;
            updatedAt: Date;
          },
        ): Effect.Effect<
          | {
              row: DbMessage | undefined;
              attachment: Attachment | null;
            }
          | { error: ForwardFailureReason; message: string }
        > =>
          Effect.gen(function* () {
            const withinQuota = yield* enforceUploadQuota(
              db,
              currentUser.id,
              original.size,
            ).pipe(
              Effect.as(true),
              Effect.catch(() => Effect.succeed(false)),
            );
            if (!withinQuota)
              return {
                error: "quota_exceeded" as const,
                message: "This attachment doesn't fit in your storage",
              };

            const storageKey = `attachments/${crypto.randomUUID()}`;
            const discardObject = storage
              .delete(storageKey)
              .pipe(Effect.ignore);
            const copiedObject = yield* storage
              .copy(original.storageKey, storageKey, original.mimeType)
              .pipe(
                Effect.as(true),
                Effect.catch(() => Effect.as(discardObject, false)),
              );
            if (!copiedObject)
              return {
                error: "invalid_content" as const,
                message: "The attachment is no longer available",
              };

            // Thrown inside the transaction to roll the attachment row
            // back when the message insert hit an idempotency conflict.
            const duplicate = Symbol("duplicate");
            const outcome = yield* Effect.tryPromise({
              try: () =>
                db.transaction(async (tx) => {
                  const attachmentRows = await tx
                    .insert(attachments)
                    .values({
                      uploaderId: currentUser.id,
                      filename: original.filename,
                      mimeType: original.mimeType,
                      size: original.size,
                      storageKey,
                      width: original.width,
                      height: original.height,
                      blurhash: original.blurhash,
                      waveform: original.waveform,
                      durationMs: original.durationMs,
                    })
                    .returning();
                  const attachmentRow = attachmentRows[0]!;
                  const messageRow = await insertMessage(tx, {
                    ...values,
                    attachmentId: attachmentRow.id,
                  });
                  if (!messageRow) throw duplicate;
                  return { attachmentRow, messageRow };
                }),
              catch: (cause) => cause,
            }).pipe(
              Effect.tapError(() => discardObject),
              Effect.catch((cause) =>
                cause === duplicate ? Effect.succeed(null) : Effect.die(cause),
              ),
            );
            if (!outcome) return { row: undefined, attachment: null };
            return {
              row: outcome.messageRow,
              attachment: toApiAttachment(
                outcome.attachmentRow,
                storage.presignGetUrl(storageKey),
              ),
            };
          });

        // One target at a time: each is its own atomic insert, version
        // bump and notification, exactly like a send, so chat-list order
        // and version-gap detection (#55) hold per chat.
        const results = yield* Effect.forEach(targetIds, forwardInto);
        return { results };
      }),
  }) satisfies ChatsHandlers;
