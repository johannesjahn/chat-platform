import { and, eq, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import { directBlockExists, recipientsMutingSender } from "../blocks.ts";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import { RealtimeConnections } from "../Realtime.ts";
import type { Message } from "../Api.ts";
import {
  chatParticipants,
  chats,
  messages,
  type DbChat,
  type DbMessage,
  type NewDbMessage,
} from "../db/schema.ts";
import {
  getChatVersion,
  getParticipants,
  notifyChatUpdated,
} from "./chatState.ts";

// The one chat send path (see "Forwarding messages" in CLAUDE.md):
// `createMessage` and every target of `forwardMessage` insert, gate and
// publish a message through these same helpers — don't fork them.

// Why a direct chat takes no new messages from `senderId`, if it doesn't.
// A *block* by either party (not a mere mute) stops messaging in both
// directions (issue #219) — checked against the other participant only, so
// group chats aren't gated and a block never applies to yourself. And once
// the other participant has deleted their account (issue #895) there's
// nobody left to read it, so the chat is read-only. Shared by
// `createMessage` and each target of `forwardMessage`.
export const directChatClosed = (
  db: DrizzleDb,
  chatRow: DbChat,
  senderId: number,
): Effect.Effect<"blocked" | "partner_deleted" | null> =>
  Effect.gen(function* () {
    if (chatRow.type !== "direct") return null;
    const others = yield* dbQuery(() =>
      db
        .select({ userId: chatParticipants.userId })
        .from(chatParticipants)
        .where(
          and(
            eq(chatParticipants.chatId, chatRow.id),
            ne(chatParticipants.userId, senderId),
          ),
        )
        .limit(1),
    );
    const otherId = others[0]?.userId;
    if (otherId === undefined) return "partner_deleted";
    return (yield* dbQuery(() => directBlockExists(db, senderId, otherId)))
      ? "blocked"
      : null;
  });

// What a sender is told when `directChatClosed` turns them away.
export const DIRECT_CHAT_CLOSED_MESSAGE = {
  blocked: "You can't send messages in this chat because of a block",
  partner_deleted:
    "You can't send messages in this chat because the account was deleted",
} as const;

// Inserts a message and bumps its chat's `updatedAt` (which `listChats`
// sorts by) and `version` as one atomic statement via a writable CTE, rather
// than two separate un-transacted round trips — Postgres always runs a
// data-modifying CTE to completion even though only `inserted`'s output is
// selected, and a single statement is atomic without needing an explicit
// transaction. Bumping `version` here (rather than a separate
// `bumpChatVersion` call after, see that helper's comment) keeps it one
// UPDATE. Resolves to `undefined` when the row's `clientId` collides with one
// this sender already stored in the chat (issue #567). Takes a plain promise
// so a forward can run it inside the transaction that also inserts its
// copied attachment.
export const insertMessage = async (
  db: DrizzleDb,
  values: NewDbMessage & { createdAt: Date; updatedAt: Date },
): Promise<DbMessage | undefined> => {
  const inserted = db
    .$with("inserted")
    .as(db.insert(messages).values(values).onConflictDoNothing().returning());
  const touched = db.$with("touched").as(
    db
      .update(chats)
      .set({ updatedAt: values.updatedAt, version: sql`${chats.version} + 1` })
      .where(eq(chats.id, values.chatId))
      .returning({ id: chats.id }),
  );
  const created = await db.with(inserted, touched).select().from(inserted);
  return created[0];
};

// The stored message this sender already sent into `chatId` under the
// idempotency key `clientId` (issue #567), if any.
export const findMessageByClientId = (
  db: DrizzleDb,
  chatId: number,
  senderId: number,
  clientId: string,
): Effect.Effect<DbMessage | undefined> =>
  dbQuery(() =>
    db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chatId),
          eq(messages.senderId, senderId),
          eq(messages.clientId, clientId),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows[0]));

// Publishes a newly stored message to the chat: reads back the version the
// insert bumped and nudges every participant with the message itself, as
// anyone but its sender sees it (its `clientId` stays with the sender — see
// `Message.clientId`), which is what a client needs to update its chat list
// without refetching it. Suppresses the nudge for any participant who has
// muted or blocked the sender (issue #219: "mute their chat
// notifications") — the message is still stored and appears when they next
// open the chat, only the push is withheld. The sender can't mute
// themselves (self-block is rejected), so they stay in the notify set.
export const publishNewMessage = (
  db: DrizzleDb,
  connections: RealtimeConnections["Service"],
  message: Message,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { chatId, senderId } = message;
    const version = yield* getChatVersion(db, chatId);
    const participants = yield* getParticipants(db, chatId);
    const recipientIds = participants.map((p) => p.userId);
    const muting = yield* dbQuery(() =>
      recipientsMutingSender(db, senderId, recipientIds),
    );
    const shared: Message = { ...message, clientId: undefined };
    yield* notifyChatUpdated(
      connections,
      chatId,
      version,
      recipientIds.filter((userId) => !muting.has(userId)),
      {
        change: "message_created",
        messageId: message.id,
        senderId,
        message: shared,
      },
    );
  });
