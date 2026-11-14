import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  type Attachment,
  PARENT_MESSAGE_PREVIEW_LENGTH,
  type Message,
  type ParentMessagePreview,
  type ReactionSummary,
} from "../Api.ts";
import { resolveAttachment, resolveAttachments } from "../attachments.ts";
import { AttachmentStorage } from "../AttachmentStorage.ts";
import { type DrizzleDb } from "../Db.ts";
import { messageReactionInfo, messageReactionInfoOne } from "../reactions.ts";
import { messagePinStarInfo, messagePinStarInfoOne } from "../pinsStars.ts";
import {
  chatParticipants,
  chats,
  messages,
  users,
  type DbMessage,
} from "../db/schema.ts";

// Turning `messages` rows into the API's `Message`: captions, parent
// previews, reactions, pins/stars and read receipts, one row or a page at a
// time.

export const NO_REACTIONS: ReactionSummary[] = [];

// A message's caption (issue #765) only counts on an "attachment" message —
// an edit by a replica that predates captions can change the type without
// clearing the column, and that leftover never shows.
export const messageCaption = (row: {
  readonly contentType: string;
  readonly caption: string | null;
}): string | null => (row.contentType === "attachment" ? row.caption : null);

export const toApiMessage = (
  row: DbMessage,
  readByUserIds: ReadonlyArray<number>,
  attachment: Attachment | null = null,
  reactions: ReadonlyArray<ReactionSummary> = NO_REACTIONS,
  parentMessage: ParentMessagePreview | null = null,
  // Pinned/starred flags (issue #223), computed on read (see pinsStars.ts).
  // Default false so the many call sites that build a freshly-created message
  // — which is never pinned or starred yet — needn't pass them.
  pinned = false,
  starred = false,
  // Who the response is for: the row's `clientId` is only echoed back to its
  // own sender (see `Message.clientId`).
  viewerId?: number,
): Message => ({
  id: row.id,
  chatId: row.chatId,
  senderId: row.senderId,
  contentType: row.contentType,
  content: row.content,
  attachment,
  caption: messageCaption(row),
  parentMessage,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  readByUserIds: [...readByUserIds],
  reactions: [...reactions],
  pinned,
  starred,
  // The sender-name snapshot is what marks a row as a forward (issue #601);
  // the id beside it goes null once that account is deleted.
  forwardedFrom:
    row.forwardedFromSenderName !== null
      ? {
          senderId: row.forwardedFromSenderId,
          senderName: row.forwardedFromSenderName,
        }
      : null,
  ...(viewerId !== undefined &&
  row.senderId === viewerId &&
  row.clientId !== null
    ? { clientId: row.clientId }
    : {}),
});

// Resolves the lightweight `parentMessage` preview (issue #217) for a batch of
// reply messages in one query — collects the distinct non-null parent ids,
// fetches each parent's row joined to its sender for the display name, and
// returns them keyed by parent message id. Callers building many messages at
// once (listMessages, the chat-list last-message batch) use this to avoid an
// N+1 parent lookup; single-message callers use `resolveParentPreview`.
export const resolveParentPreviews = (
  db: DrizzleDb,
  parentIds: ReadonlyArray<number | null>,
): Effect.Effect<Map<number, ParentMessagePreview>> =>
  Effect.gen(function* () {
    const ids = [
      ...new Set(parentIds.filter((id): id is number => id !== null)),
    ];
    if (ids.length === 0) return new Map<number, ParentMessagePreview>();
    const rows = yield* Effect.tryPromise(() =>
      db
        .select({
          id: messages.id,
          senderId: messages.senderId,
          contentType: messages.contentType,
          content: messages.content,
          caption: messages.caption,
          forwardedFromSenderName: messages.forwardedFromSenderName,
          displayName: users.displayName,
          username: users.username,
        })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.senderId))
        .where(inArray(messages.id, ids)),
    ).pipe(Effect.orDie);
    const previews = new Map<number, ParentMessagePreview>();
    for (const row of rows) {
      previews.set(row.id, {
        id: row.id,
        senderId: row.senderId,
        // displayName ?? username — the same fallback `userLabel` applies
        // client-side, resolved here so the client needn't have the (possibly
        // since-departed) sender on hand.
        senderName: row.displayName ?? row.username,
        contentType: row.contentType,
        // Only a one-line snippet is ever shown in a quote — truncate rather
        // than shipping the parent's full body on every reply.
        content: row.content.slice(0, PARENT_MESSAGE_PREVIEW_LENGTH),
        caption:
          messageCaption(row)?.slice(0, PARENT_MESSAGE_PREVIEW_LENGTH) ?? null,
        forwarded: row.forwardedFromSenderName !== null,
      });
    }
    return previews;
  });

export const resolveParentPreview = (
  db: DrizzleDb,
  parentId: number | null,
): Effect.Effect<ParentMessagePreview | null> =>
  Effect.map(resolveParentPreviews(db, [parentId]), (previews) =>
    parentId !== null ? (previews.get(parentId) ?? null) : null,
  );

// Hydrates a single already-fetched message row into a full `Message`
// response for `userId` — its read receipts, attachment, reactions, quoted
// parent preview, and pinned/starred flags. The per-message counterpart to the
// batched builders in `listMessages`/`getLastMessagesForChats`; used by the
// pin/star/edit endpoints, which each mutate exactly one message and return
// its refreshed state. `pinnedOverride`/`starredOverride` let the pin/star
// handlers skip the extra lookup and assert the state they just wrote, rather
// than re-reading a row they know the value of.
export const buildMessageResponse = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  row: DbMessage,
  userId: number,
  pinnedOverride?: boolean,
  starredOverride?: boolean,
): Effect.Effect<Message> =>
  Effect.gen(function* () {
    const readers = yield* getReaders(db, row);
    const attachment = yield* resolveAttachment(db, storage, row.attachmentId);
    const reactions = yield* Effect.tryPromise(() =>
      messageReactionInfoOne(db, row.id, userId),
    ).pipe(Effect.orDie);
    const parentMessage = yield* resolveParentPreview(db, row.parentMessageId);
    const pinStar =
      pinnedOverride !== undefined && starredOverride !== undefined
        ? { pinned: pinnedOverride, starred: starredOverride }
        : yield* Effect.tryPromise(() =>
            messagePinStarInfoOne(db, row.id, userId),
          ).pipe(Effect.orDie);
    return toApiMessage(
      row,
      readers,
      attachment,
      reactions,
      parentMessage,
      pinnedOverride ?? pinStar.pinned,
      starredOverride ?? pinStar.starred,
      userId,
    );
  });

// Batched hydration of a set of already-fetched message rows into full
// `Message` responses for `userId`, preserving the input row order — the same
// read-receipt/attachment/reaction/parent/pin-star fan-out `listMessages`
// does inline, factored out for the pinned/starred list endpoints (which
// fetch rows in an explicit "newest-pinned/starred first" order and must keep
// it). One query per facet across all ids, not per-message.
const hydrateMessages = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  rows: ReadonlyArray<DbMessage>,
  userId: number,
): Effect.Effect<Message[]> =>
  Effect.gen(function* () {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const readersByMessage = yield* getReadersForMessages(db, rows);
    const attachmentsByRow = yield* resolveAttachments(
      db,
      storage,
      rows.map((r) => r.attachmentId),
    );
    const reactionsByMessage = yield* Effect.tryPromise(() =>
      messageReactionInfo(db, ids, userId),
    ).pipe(Effect.orDie);
    const pinStarByMessage = yield* Effect.tryPromise(() =>
      messagePinStarInfo(db, ids, userId),
    ).pipe(Effect.orDie);
    const parentPreviews = yield* resolveParentPreviews(
      db,
      rows.map((r) => r.parentMessageId),
    );
    return rows.map((row) => {
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
        userId,
      );
    });
  });

// Fetches `messageIds`' rows and hydrates them into full `Message` responses,
// preserving the given id order (the pinned/starred lists come pre-sorted
// newest-first). A message id present in `messageIds` but since deleted simply
// drops out of the result.
export const buildMessagesInOrder = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  messageIds: ReadonlyArray<number>,
  userId: number,
): Effect.Effect<Message[]> =>
  Effect.gen(function* () {
    if (messageIds.length === 0) return [];
    const rows = yield* Effect.tryPromise(() =>
      db.select().from(messages).where(inArray(messages.id, messageIds)),
    ).pipe(Effect.orDie);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = messageIds
      .map((id) => byId.get(id))
      .filter((r): r is DbMessage => r !== undefined);
    return yield* hydrateMessages(db, storage, ordered, userId);
  });

export const getLastMessage = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  chatId: number,
  userId: number,
): Effect.Effect<Message | null> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(desc(messages.id))
        .limit(1),
    ).pipe(Effect.orDie);
    const row = rows[0];
    if (!row) return null;
    return yield* buildMessageResponse(db, storage, row, userId);
  });

// The messages a participant has read, as identified by their read
// watermark (`chat_participants.last_read_message_id`, issue #659).
type MessageReadKey = Pick<
  DbMessage,
  "id" | "chatId" | "senderId" | "createdAt"
>;

// Who has read each of `rows`: every current participant of its chat, other
// than its sender, whose watermark has reached it and who was in the chat
// when it was sent — a joiner's watermark starts at the newest message
// (issue #686), which means "nothing unread", not "read the backlog". One
// query over the participants of the chats involved (a handful of rows
// each), never over the message history. Ids are ascending, so the order is
// stable.
export const getReadersForMessages = (
  db: DrizzleDb,
  rows: ReadonlyArray<MessageReadKey>,
): Effect.Effect<Map<number, number[]>> =>
  Effect.gen(function* () {
    const byMessage = new Map<number, number[]>();
    if (rows.length === 0) return byMessage;
    const chatIds = [...new Set(rows.map((r) => r.chatId))];
    const oldest = Math.min(...rows.map((r) => r.id));
    const watermarks = yield* Effect.tryPromise(() =>
      db
        .select({
          chatId: chatParticipants.chatId,
          userId: chatParticipants.userId,
          lastRead: chatParticipants.lastReadMessageId,
          joinedAt: chatParticipants.joinedAt,
        })
        .from(chatParticipants)
        .where(
          and(
            inArray(chatParticipants.chatId, chatIds),
            gte(chatParticipants.lastReadMessageId, oldest),
          ),
        )
        .orderBy(chatParticipants.userId),
    ).pipe(Effect.orDie);
    for (const row of rows) {
      byMessage.set(
        row.id,
        watermarks
          .filter(
            (w) =>
              w.chatId === row.chatId &&
              w.userId !== row.senderId &&
              w.lastRead !== null &&
              w.lastRead >= row.id &&
              w.joinedAt <= row.createdAt,
          )
          .map((w) => w.userId),
      );
    }
    return byMessage;
  });

export const getLastMessagesForChats = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  chatIds: ReadonlyArray<number>,
  userId: number,
): Effect.Effect<Map<number, Message>> =>
  Effect.gen(function* () {
    const byChat = new Map<number, Message>();
    if (chatIds.length === 0) return byChat;

    // One most-recent message id per chat, then fetch just those messages —
    // avoids pulling every message in every chat to pick the last one. A
    // per-chat `ORDER BY id DESC LIMIT 1` is one backward step down the
    // `(chat_id, id)` index; a `max(id) … GROUP BY chat_id` instead reads
    // every message in every chat (issue #659).
    const latest = yield* Effect.tryPromise(() =>
      db
        .select({
          // Spelled out with an alias: in a single-table select Drizzle
          // renders `${messages.chatId}` unqualified, which inside this
          // subquery would bind to `messages`, not the outer `chats`.
          lastId: sql<number | null>`(
            SELECT latest.id FROM ${messages} AS latest
            WHERE latest.chat_id = ${chats}.id
            ORDER BY latest.id DESC
            LIMIT 1
          )`,
        })
        .from(chats)
        .where(inArray(chats.id, chatIds)),
    ).pipe(Effect.orDie);
    const lastIds = latest
      .map((r) => r.lastId)
      .filter((id): id is number => id !== null);
    if (lastIds.length === 0) return byChat;

    const rows = yield* Effect.tryPromise(() =>
      db.select().from(messages).where(inArray(messages.id, lastIds)),
    ).pipe(Effect.orDie);
    const readersByMessage = yield* getReadersForMessages(db, rows);
    const attachmentsByRow = yield* resolveAttachments(
      db,
      storage,
      rows.map((r) => r.attachmentId),
    );
    const reactionsByMessage = yield* Effect.tryPromise(() =>
      messageReactionInfo(
        db,
        rows.map((r) => r.id),
        userId,
      ),
    ).pipe(Effect.orDie);
    const pinStarByMessage = yield* Effect.tryPromise(() =>
      messagePinStarInfo(
        db,
        rows.map((r) => r.id),
        userId,
      ),
    ).pipe(Effect.orDie);
    const parentPreviews = yield* resolveParentPreviews(
      db,
      rows.map((r) => r.parentMessageId),
    );
    for (const row of rows) {
      const pinStar = pinStarByMessage.get(row.id);
      byChat.set(
        row.chatId,
        toApiMessage(
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
          userId,
        ),
      );
    }
    return byChat;
  });

export const getReaders = (
  db: DrizzleDb,
  message: MessageReadKey,
): Effect.Effect<ReadonlyArray<number>> =>
  getReadersForMessages(db, [message]).pipe(
    Effect.map((byMessage) => byMessage.get(message.id) ?? []),
  );
