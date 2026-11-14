import {
  and,
  count,
  countDistinct,
  eq,
  gt,
  inArray,
  ne,
  sql,
} from "drizzle-orm";
import { Effect } from "effect";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import { chatParticipants, messages } from "../db/schema.ts";

// Unread counts against each participant's read watermark
// (`chat_participants.last_read_message_id`). The counts leave pending
// message requests out (issue #785).

// Messages in this chat sent by someone other than `userId` that `userId`
// hasn't marked as read yet.
export const getUnreadCount = (
  db: DrizzleDb,
  chatId: number,
  userId: number,
): Effect.Effect<number> =>
  getUnreadCountsForChats(db, [chatId], userId).pipe(
    Effect.map((byChat) => byChat.get(chatId) ?? 0),
  );

// The read watermark a new participant row starts at: the chat's newest
// message id at the moment they join, so a joiner — new, or rejoining after
// leaving or being removed, which deleted their old row and its watermark —
// starts with nothing unread, and only messages sent after joining count
// (issue #686). Evaluated inside the insert, so it sees the same snapshot.
// Null for a chat with no messages yet, which reads the same as "nothing
// read" with nothing to read.
export const newestMessageIdIn = (chatId: number) =>
  sql<number | null>`(
    SELECT newest.id FROM ${messages} AS newest
    WHERE newest.chat_id = ${chatId}
    ORDER BY newest.id DESC
    LIMIT 1
  )`;

export const getUnreadCountsForChats = (
  db: DrizzleDb,
  chatIds: ReadonlyArray<number>,
  userId: number,
): Effect.Effect<Map<number, number>> =>
  chatIds.length === 0
    ? Effect.succeed(new Map())
    : // Joined through the reader's own participant row, so each chat only
      // counts past its watermark — a range scan over `(chat_id, id)` that
      // reads the unread messages, not the whole history (issue #659).
      dbQuery(() =>
        db
          .select({ chatId: messages.chatId, total: count() })
          .from(chatParticipants)
          .innerJoin(
            messages,
            and(
              eq(messages.chatId, chatParticipants.chatId),
              gt(
                messages.id,
                sql`coalesce(${chatParticipants.lastReadMessageId}, 0)`,
              ),
            ),
          )
          .where(
            and(
              inArray(chatParticipants.chatId, chatIds),
              eq(chatParticipants.userId, userId),
              // A message request never shows as unread (issue #785).
              eq(chatParticipants.requestPending, false),
              ne(messages.senderId, userId),
            ),
          )
          .groupBy(messages.chatId),
      ).pipe(
        Effect.map((rows) => new Map(rows.map((r) => [r.chatId, r.total]))),
      );

// The caller's unread total over every chat they're in (issue #756), for
// `GET /chats/unread-count` — the same watermark join as
// `getUnreadCountsForChats`, just not narrowed to one page's chats, so a
// chat that's dropped off the first page of the list still counts.
export const getUnreadTotal = (
  db: DrizzleDb,
  userId: number,
): Effect.Effect<{ count: number; chats: number }> =>
  dbQuery(() =>
    db
      .select({ count: count(), chats: countDistinct(messages.chatId) })
      .from(chatParticipants)
      .innerJoin(
        messages,
        and(
          eq(messages.chatId, chatParticipants.chatId),
          gt(
            messages.id,
            sql`coalesce(${chatParticipants.lastReadMessageId}, 0)`,
          ),
        ),
      )
      .where(
        and(
          eq(chatParticipants.userId, userId),
          // Message requests stay out of the badge (issue #785).
          eq(chatParticipants.requestPending, false),
          ne(messages.senderId, userId),
        ),
      ),
  ).pipe(
    Effect.map((rows) => ({
      count: rows[0]?.count ?? 0,
      chats: rows[0]?.chats ?? 0,
    })),
  );

// `listChats`'s `unread=true` filter (issue #756): the caller's own
// participant row (joined into that query) has a message past its watermark
// from someone else — the same rule `getUnreadCountsForChats` counts by.
// Spelled out with an alias for the reason in `getLastMessagesForChats`.
export const hasUnreadFor = (userId: number) =>
  sql<boolean>`EXISTS (
    SELECT 1 FROM ${messages} AS unread
    WHERE unread.chat_id = ${chatParticipants}.chat_id
      AND unread.id > coalesce(${chatParticipants}.last_read_message_id, 0)
      AND unread.sender_id <> ${userId}
  )`;
