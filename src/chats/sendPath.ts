import { and, eq, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import { directBlockExists, recipientsMutingSender } from "../blocks.ts";
import { type DrizzleDb } from "../Db.ts";
import { RealtimeConnections } from "../Realtime.ts";
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

// In a direct chat, a *block* by either party (not a mere mute) stops
// messaging in both directions (issue #219). Checked against the other
// participant only — group chats aren't gated, and a block never applies to
// yourself. Shared by `createMessage` and each target of `forwardMessage`.
export const directChatBlocked = (
  db: DrizzleDb,
  chatRow: DbChat,
  senderId: number,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (chatRow.type !== "direct") return false;
    const others = yield* Effect.tryPromise(() =>
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
    ).pipe(Effect.orDie);
    const otherId = others[0]?.userId;
    if (otherId === undefined) return false;
    return yield* Effect.tryPromise(() =>
      directBlockExists(db, senderId, otherId),
    ).pipe(Effect.orDie);
  });

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
  Effect.tryPromise(() =>
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
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0]),
  );

// Publishes a newly stored message to the chat: reads back the version the
// insert bumped and nudges every participant. Suppresses the nudge for any
// participant who has muted or blocked the sender (issue #219: "mute their
// chat notifications") — the message is still stored and appears when they
// next open the chat, only the push is withheld. The sender can't mute
// themselves (self-block is rejected), so they stay in the notify set.
export const publishNewMessage = (
  db: DrizzleDb,
  connections: RealtimeConnections["Service"],
  chatId: number,
  senderId: number,
  messageId: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const version = yield* getChatVersion(db, chatId);
    const participants = yield* getParticipants(db, chatId);
    const recipientIds = participants.map((p) => p.userId);
    const muting = yield* Effect.tryPromise(() =>
      recipientsMutingSender(db, senderId, recipientIds),
    ).pipe(Effect.orDie);
    yield* notifyChatUpdated(
      connections,
      chatId,
      version,
      recipientIds.filter((userId) => !muting.has(userId)),
      { change: "message_created", messageId, senderId },
    );
  });
