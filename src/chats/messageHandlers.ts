import { and, desc, eq, gt, lt } from "drizzle-orm";
import { Effect, Metric } from "effect";
import {
  type Attachment,
  DEFAULT_MESSAGES_LIMIT,
  Forbidden,
  InvalidChatRequest,
  type ParentMessagePreview,
} from "../Api.ts";
import {
  getOwnedAttachmentOr404,
  resolveAttachments,
  toApiAttachment,
} from "../attachments.ts";
import { CurrentUser } from "../Auth.ts";
import { type DrizzleDb } from "../Db.ts";
import { contentCreatedTotal } from "../Metrics.ts";
import { messageReactionInfo, messageReactionInfoOne } from "../reactions.ts";
import { messagePinStarInfo, messagePinStarInfoOne } from "../pinsStars.ts";
import { likes, messages } from "../db/schema.ts";
import { type ChatsDeps, type ChatsHandlers } from "./handlerKit.ts";
import {
  getChatOr404,
  getMessageOr404,
  getParticipantRole,
  requireAcceptedParticipant,
  requireParticipant,
} from "./access.ts";
import {
  bumpChatVersion,
  getParticipants,
  notifyChatUpdated,
} from "./chatState.ts";
import {
  NO_REACTIONS,
  buildMessageResponse,
  getReaders,
  getReadersForMessages,
  messageCaption,
  resolveParentPreview,
  resolveParentPreviews,
  toApiMessage,
} from "./messageViews.ts";
import {
  directChatBlocked,
  findMessageByClientId,
  insertMessage,
  publishNewMessage,
} from "./sendPath.ts";

// Site-wide admins can edit/delete any message; everyone else only their
// own — mirrors PostsHandler's `canModify`. Editing stays this strict even
// after issue #220 (only deletion was extended to chat owners/admins below).
const canModifyMessage = (
  currentUser: { readonly id: number; readonly role: string },
  message: { readonly senderId: number },
): boolean =>
  currentUser.role === "admin" || message.senderId === currentUser.id;

// Deleting is broader than editing (issue #220): the message's own sender, a
// site-wide admin, or the chat's own owner/admin (moderating their group) may
// delete it.
const canDeleteMessage = (
  db: DrizzleDb,
  currentUser: { readonly id: number; readonly role: string },
  chatId: number,
  message: { readonly senderId: number },
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (canModifyMessage(currentUser, message)) return true;
    const role = yield* getParticipantRole(db, chatId, currentUser.id);
    return role === "owner" || role === "admin";
  });

// Keyset cursor for `listMessages` over its per-chat `id asc` sort — see
// `MessagesPageQuery` in Api.ts for why this takes a `before`/`after` cursor
// rather than an offset. A message's id alone is enough (no tie-breaker
// column needed, unlike `listChats`'s cursor), since messages are never
// reordered by edits.
const encodeMessagesCursor = (id: number): string =>
  Buffer.from(String(id)).toString("base64url");

const decodeMessagesCursor = (cursor: string): number | null => {
  const id = Number(Buffer.from(cursor, "base64url").toString());
  return Number.isInteger(id) ? id : null;
};

export const messageHandlers = ({ db, storage, connections }: ChatsDeps) =>
  ({
    listMessages: ({ params: { id }, query: urlParams }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* getChatOr404(db, id);
        yield* requireParticipant(db, id, currentUser.id);

        if (urlParams.before !== undefined && urlParams.after !== undefined)
          return yield* Effect.fail(
            new InvalidChatRequest({
              message: "Cannot set both before and after",
            }),
          );

        const limit = urlParams.limit ?? DEFAULT_MESSAGES_LIMIT;
        let before: number | null = null;
        let after: number | null = null;
        if (urlParams.before !== undefined) {
          before = decodeMessagesCursor(urlParams.before);
          if (before === null)
            return yield* Effect.fail(
              new InvalidChatRequest({ message: "Invalid cursor" }),
            );
        } else if (urlParams.after !== undefined) {
          after = decodeMessagesCursor(urlParams.after);
          if (after === null)
            return yield* Effect.fail(
              new InvalidChatRequest({ message: "Invalid cursor" }),
            );
        }

        // Fetch one row past `limit` instead of a separate `COUNT(*)` on
        // every request — this is the hot path (scrolling, socket-triggered
        // refetches), so it stays cheap no matter how long the chat's
        // history gets (issue #51).
        let rows: Array<typeof messages.$inferSelect>;
        let hasEarlier: boolean;
        let hasNewer: boolean;
        if (after !== null) {
          // Forward page: whatever arrived after a previously-loaded
          // window's newest message (catching up after a `chat_updated`
          // event) — ascending, same direction as the base sort.
          const fetched = yield* Effect.tryPromise(() =>
            db
              .select()
              .from(messages)
              .where(and(eq(messages.chatId, id), gt(messages.id, after)))
              .orderBy(messages.id)
              .limit(limit + 1),
          ).pipe(Effect.orDie);
          hasNewer = fetched.length > limit;
          rows = fetched.slice(0, limit);
          // `after`'s own message (older than everything returned here) is
          // guaranteed to exist, so there's always something earlier.
          hasEarlier = true;
        } else {
          // Backward-oriented page: the newest window (no cursor) or the
          // `limit` messages immediately preceding `before` (paging up) —
          // fetched newest-first so `limit + 1` finds the right end of the
          // window, then reversed back to the base oldest-first order.
          const fetched = yield* Effect.tryPromise(() =>
            db
              .select()
              .from(messages)
              .where(
                before !== null
                  ? and(eq(messages.chatId, id), lt(messages.id, before))
                  : eq(messages.chatId, id),
              )
              .orderBy(desc(messages.id))
              .limit(limit + 1),
          ).pipe(Effect.orDie);
          hasEarlier = fetched.length > limit;
          rows = fetched.slice(0, limit).reverse();
          // `before`'s own message (newer than everything returned here) is
          // guaranteed to exist, so there's always something newer.
          hasNewer = before !== null;
        }

        const earliestCursor = rows[0]
          ? encodeMessagesCursor(rows[0].id)
          : null;
        const latestCursor = rows[rows.length - 1]
          ? encodeMessagesCursor(rows[rows.length - 1]!.id)
          : null;

        const messageIds = rows.map((r) => r.id);
        const readersByMessage = yield* getReadersForMessages(db, rows);
        const attachmentsByRow = yield* resolveAttachments(
          db,
          storage,
          rows.map((r) => r.attachmentId),
        );
        const reactionsByMessage = yield* Effect.tryPromise(() =>
          messageReactionInfo(db, messageIds, currentUser.id),
        ).pipe(Effect.orDie);
        const pinStarByMessage = yield* Effect.tryPromise(() =>
          messagePinStarInfo(db, messageIds, currentUser.id),
        ).pipe(Effect.orDie);
        const parentPreviews = yield* resolveParentPreviews(
          db,
          rows.map((r) => r.parentMessageId),
        );

        return {
          messages: rows.map((row) => {
            const pinStar = pinStarByMessage.get(row.id);
            return toApiMessage(
              row,
              readersByMessage.get(row.id) ?? [],
              row.attachmentId !== null
                ? (attachmentsByRow.get(row.attachmentId) ?? null)
                : null,
              reactionsByMessage.get(row.id),
              row.parentMessageId !== null
                ? (parentPreviews.get(row.parentMessageId) ?? null)
                : null,
              pinStar?.pinned ?? false,
              pinStar?.starred ?? false,
              currentUser.id,
            );
          }),
          limit,
          hasEarlier,
          hasNewer,
          earliestCursor,
          latestCursor,
        };
      }),
    createMessage: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const chatRow = yield* getChatOr404(db, id);
        yield* requireAcceptedParticipant(db, id, currentUser.id);

        // A repeat of a send the server already stored (issue #567) — e.g.
        // the page reloaded mid-request and the offline queue replayed it —
        // returns the original message untouched: no second row, no second
        // notification.
        if (payload.clientId !== undefined) {
          const existing = yield* findMessageByClientId(
            db,
            id,
            currentUser.id,
            payload.clientId,
          );
          if (existing)
            return yield* buildMessageResponse(
              db,
              storage,
              existing,
              currentUser.id,
            );
        }

        if (yield* directChatBlocked(db, chatRow, currentUser.id))
          return yield* Effect.fail(
            new Forbidden({
              message:
                "You can't send messages in this chat because of a block",
            }),
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

        // A reply must quote a message in *this* chat (issue #217).
        // `getMessageOr404` filters on (chatId, messageId), so a parent from
        // another chat — or one that doesn't exist — 404s here, and the
        // returned row is reused to build the response's `parentMessage`
        // preview rather than re-fetching it.
        let parentMessage: ParentMessagePreview | null = null;
        if (payload.parentMessageId !== undefined) {
          yield* getMessageOr404(db, id, payload.parentMessageId);
          parentMessage = yield* resolveParentPreview(
            db,
            payload.parentMessageId,
          );
        }

        const now = new Date();
        const row = yield* Effect.tryPromise(() =>
          insertMessage(db, {
            chatId: id,
            senderId: currentUser.id,
            contentType: payload.contentType,
            content: payload.content,
            attachmentId: payload.attachmentId ?? null,
            caption: payload.caption ?? null,
            parentMessageId: payload.parentMessageId ?? null,
            clientId: payload.clientId ?? null,
            createdAt: now,
            updatedAt: now,
          }),
        ).pipe(Effect.orDie);
        if (!row && payload.clientId !== undefined) {
          // Lost a race with a concurrent send of the same key.
          const existing = yield* findMessageByClientId(
            db,
            id,
            currentUser.id,
            payload.clientId,
          );
          if (existing)
            return yield* buildMessageResponse(
              db,
              storage,
              existing,
              currentUser.id,
            );
        }
        if (!row)
          return yield* Effect.die(new Error("INSERT returned no rows"));
        yield* Metric.update(
          Metric.withAttributes(contentCreatedTotal, { type: "message" }),
          1,
        );

        yield* publishNewMessage(db, connections, id, currentUser.id, row.id);
        return toApiMessage(
          row,
          [],
          attachment,
          NO_REACTIONS,
          parentMessage,
          false,
          false,
          currentUser.id,
        );
      }),
    sendTyping: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* getChatOr404(db, id);
        yield* requireAcceptedParticipant(db, id, currentUser.id);

        const participants = yield* getParticipants(db, id);
        const others = participants
          .map((p) => p.userId)
          .filter((userId) => userId !== currentUser.id);
        const self = participants.find((p) => p.userId === currentUser.id);
        yield* connections.notifyUsers(others, {
          type: "typing",
          chatId: id,
          userId: currentUser.id,
          username: currentUser.username,
          displayName: self?.displayName ?? null,
        });
      }),
    updateMessage: ({ params: { id, messageId }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* getChatOr404(db, id);
        yield* requireAcceptedParticipant(db, id, currentUser.id);
        const existing = yield* getMessageOr404(db, id, messageId);
        if (!canModifyMessage(currentUser, existing))
          return yield* Effect.fail(
            new Forbidden({ message: "You can only edit your own messages" }),
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
            .update(messages)
            .set({
              contentType: payload.contentType,
              content: payload.content,
              attachmentId: payload.attachmentId ?? null,
              // Omitted keeps the current caption (see `UpdateMessageBody`);
              // only an attachment carries one.
              caption:
                payload.contentType !== "attachment"
                  ? null
                  : payload.caption === undefined
                    ? messageCaption(existing)
                    : payload.caption,
              updatedAt: new Date(),
            })
            .where(eq(messages.id, messageId))
            .returning(),
        ).pipe(Effect.orDie);
        const row = rows[0];
        if (!row)
          return yield* Effect.die(new Error("UPDATE returned no rows"));

        const readers = yield* getReaders(db, row);
        const reactions = yield* Effect.tryPromise(() =>
          messageReactionInfoOne(db, messageId, currentUser.id),
        ).pipe(Effect.orDie);
        // An edit never changes what a reply quotes (UpdateMessageBody has no
        // `parentMessageId`), but the response must still carry the existing
        // preview so the client doesn't drop the quote on edit.
        const parentMessage = yield* resolveParentPreview(
          db,
          row.parentMessageId,
        );
        const pinStar = yield* Effect.tryPromise(() =>
          messagePinStarInfoOne(db, messageId, currentUser.id),
        ).pipe(Effect.orDie);
        const version = yield* bumpChatVersion(db, id);
        const participants = yield* getParticipants(db, id);
        yield* notifyChatUpdated(
          connections,
          id,
          version,
          participants.map((p) => p.userId),
        );
        return toApiMessage(
          row,
          readers,
          attachment,
          reactions,
          parentMessage,
          pinStar.pinned,
          pinStar.starred,
          currentUser.id,
        );
      }),
    deleteMessage: ({ params: { id, messageId } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* getChatOr404(db, id);
        yield* requireParticipant(db, id, currentUser.id);
        const existing = yield* getMessageOr404(db, id, messageId);
        const canDelete = yield* canDeleteMessage(
          db,
          currentUser,
          id,
          existing,
        );
        if (!canDelete)
          return yield* Effect.fail(
            new Forbidden({
              message:
                "You can only delete your own messages, unless you're the chat's owner or an admin",
            }),
          );

        yield* Effect.tryPromise(() =>
          db.delete(messages).where(eq(messages.id, messageId)),
        ).pipe(Effect.orDie);

        const version = yield* bumpChatVersion(db, id);
        const participants = yield* getParticipants(db, id);
        yield* notifyChatUpdated(
          connections,
          id,
          version,
          participants.map((p) => p.userId),
        );
      }),
    addMessageReaction: ({ params: { id, messageId }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* getChatOr404(db, id);
        yield* requireAcceptedParticipant(db, id, currentUser.id);
        yield* getMessageOr404(db, id, messageId);
        // Idempotent: the (userId, messageId, emoji) unique constraint
        // turns a repeat reaction with the same emoji into a no-op rather
        // than a duplicate row or an error — same convention as
        // `addPostReaction`/`addCommentReaction` (see EngagementHandler.ts).
        const inserted = yield* Effect.tryPromise(() =>
          db
            .insert(likes)
            .values({
              userId: currentUser.id,
              messageId,
              emoji: payload.emoji,
            })
            .onConflictDoNothing()
            .returning(),
        ).pipe(Effect.orDie);
        const reactions = yield* Effect.tryPromise(() =>
          messageReactionInfoOne(db, messageId, currentUser.id),
        ).pipe(Effect.orDie);
        if (inserted.length > 0) {
          // Scoped to the message's chat participants, not broadcast — a
          // chat message is private to them, unlike a post's feed-wide
          // reaction (see ReactionEvent in Realtime.ts).
          const participants = yield* getParticipants(db, id);
          yield* connections.notifyUsers(
            participants.map((p) => p.userId),
            {
              type: "reaction_changed",
              targetType: "message",
              targetId: messageId,
              chatId: id,
              reactions: reactions.map(({ emoji, count }) => ({
                emoji,
                count,
              })),
            },
          );
        }
        return { reactions };
      }),
    removeMessageReaction: ({ params: { id, messageId }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* getChatOr404(db, id);
        yield* requireAcceptedParticipant(db, id, currentUser.id);
        yield* getMessageOr404(db, id, messageId);
        const deleted = yield* Effect.tryPromise(() =>
          db
            .delete(likes)
            .where(
              and(
                eq(likes.userId, currentUser.id),
                eq(likes.messageId, messageId),
                eq(likes.emoji, payload.emoji),
              ),
            )
            .returning(),
        ).pipe(Effect.orDie);
        const reactions = yield* Effect.tryPromise(() =>
          messageReactionInfoOne(db, messageId, currentUser.id),
        ).pipe(Effect.orDie);
        if (deleted.length > 0) {
          const participants = yield* getParticipants(db, id);
          yield* connections.notifyUsers(
            participants.map((p) => p.userId),
            {
              type: "reaction_changed",
              targetType: "message",
              targetId: messageId,
              chatId: id,
              reactions: reactions.map(({ emoji, count }) => ({
                emoji,
                count,
              })),
            },
          );
        }
        return { reactions };
      }),
  }) satisfies ChatsHandlers;
