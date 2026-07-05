import { HttpApiBuilder } from "@effect/platform";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  max,
  ne,
} from "drizzle-orm";
import { Context, Effect } from "effect";
import {
  ChatApi,
  DEFAULT_MESSAGES_LIMIT,
  Forbidden,
  InvalidChatRequest,
  MAX_GROUP_PARTICIPANTS,
  NotFound,
  type Chat,
  type ChatParticipant,
  type Message,
} from "./Api.ts";
import { CurrentUser } from "./Auth.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { RealtimeConnections } from "./Realtime.ts";
import {
  chatParticipants,
  chats,
  messageReads,
  messages,
  users,
  type DbChat,
  type DbMessage,
} from "./db/schema.ts";

const toApiMessage = (
  row: DbMessage,
  readByUserIds: ReadonlyArray<number>,
): Message => ({
  id: row.id,
  chatId: row.chatId,
  senderId: row.senderId,
  contentType: row.contentType,
  content: row.content,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  readByUserIds: [...readByUserIds],
});

const getParticipants = (
  db: DrizzleDb,
  chatId: number,
): Effect.Effect<ReadonlyArray<ChatParticipant>> =>
  Effect.tryPromise(() =>
    db
      .select({ userId: chatParticipants.userId, username: users.username })
      .from(chatParticipants)
      .innerJoin(users, eq(users.id, chatParticipants.userId))
      .where(eq(chatParticipants.chatId, chatId)),
  ).pipe(Effect.orDie);

// Pushes a `chat_updated` event to every current participant of `chatId` so
// their chat list / open conversation can refetch instead of polling for it.
// Takes the participant ids rather than re-deriving them from `chatId` —
// every call site already has a freshly-fetched participant list on hand for
// building its own response (see `buildChat`), so this avoids a second
// `getParticipants` round-trip per mutation.
const notifyChatUpdated = (
  connections: Context.Tag.Service<typeof RealtimeConnections>,
  chatId: number,
  participantUserIds: ReadonlyArray<number>,
): Effect.Effect<void> =>
  connections.notifyUsers(participantUserIds, { type: "chat_updated", chatId });

const getLastMessage = (
  db: DrizzleDb,
  chatId: number,
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
    const readers = yield* Effect.tryPromise(() =>
      db
        .select({ userId: messageReads.userId })
        .from(messageReads)
        .where(eq(messageReads.messageId, row.id)),
    ).pipe(Effect.orDie);
    return toApiMessage(
      row,
      readers.map((r) => r.userId),
    );
  });

// Messages in this chat sent by someone other than `userId` that `userId`
// hasn't marked as read yet.
const getUnreadCount = (
  db: DrizzleDb,
  chatId: number,
  userId: number,
): Effect.Effect<number> =>
  Effect.tryPromise(async () => {
    const rows = await db
      .select({ total: count() })
      .from(messages)
      .leftJoin(
        messageReads,
        and(
          eq(messageReads.messageId, messages.id),
          eq(messageReads.userId, userId),
        ),
      )
      .where(
        and(
          eq(messages.chatId, chatId),
          ne(messages.senderId, userId),
          isNull(messageReads.id),
        ),
      );
    return rows[0]?.total ?? 0;
  }).pipe(Effect.orDie);

// Batched equivalents of getParticipants/getLastMessage/getUnreadCount for
// building many chats at once (e.g. listChats) — each does one query (plus,
// for last-message, one extra query to resolve read receipts) across all
// `chatIds` instead of firing per-chat, avoiding an N+1 round trip per chat.

const getParticipantsForChats = (
  db: DrizzleDb,
  chatIds: ReadonlyArray<number>,
): Effect.Effect<Map<number, ChatParticipant[]>> =>
  chatIds.length === 0
    ? Effect.succeed(new Map())
    : Effect.tryPromise(() =>
        db
          .select({
            chatId: chatParticipants.chatId,
            userId: chatParticipants.userId,
            username: users.username,
          })
          .from(chatParticipants)
          .innerJoin(users, eq(users.id, chatParticipants.userId))
          .where(inArray(chatParticipants.chatId, chatIds)),
      ).pipe(
        Effect.orDie,
        Effect.map((rows) => {
          const byChat = new Map<number, ChatParticipant[]>();
          for (const { chatId, ...participant } of rows) {
            const list = byChat.get(chatId) ?? [];
            list.push(participant);
            byChat.set(chatId, list);
          }
          return byChat;
        }),
      );

const getLastMessagesForChats = (
  db: DrizzleDb,
  chatIds: ReadonlyArray<number>,
): Effect.Effect<Map<number, Message>> =>
  Effect.gen(function* () {
    const byChat = new Map<number, Message>();
    if (chatIds.length === 0) return byChat;

    // One most-recent message id per chat, then fetch just those messages —
    // avoids pulling every message in every chat to pick the last one.
    const latest = yield* Effect.tryPromise(() =>
      db
        .select({ lastId: max(messages.id) })
        .from(messages)
        .where(inArray(messages.chatId, chatIds))
        .groupBy(messages.chatId),
    ).pipe(Effect.orDie);
    const lastIds = latest
      .map((r) => r.lastId)
      .filter((id): id is number => id !== null);
    if (lastIds.length === 0) return byChat;

    const rows = yield* Effect.tryPromise(() =>
      db.select().from(messages).where(inArray(messages.id, lastIds)),
    ).pipe(Effect.orDie);
    const readRows = yield* Effect.tryPromise(() =>
      db
        .select({
          messageId: messageReads.messageId,
          userId: messageReads.userId,
        })
        .from(messageReads)
        .where(inArray(messageReads.messageId, lastIds)),
    ).pipe(Effect.orDie);
    const readersByMessage = new Map<number, number[]>();
    for (const r of readRows) {
      const list = readersByMessage.get(r.messageId) ?? [];
      list.push(r.userId);
      readersByMessage.set(r.messageId, list);
    }
    for (const row of rows) {
      byChat.set(
        row.chatId,
        toApiMessage(row, readersByMessage.get(row.id) ?? []),
      );
    }
    return byChat;
  });

const getUnreadCountsForChats = (
  db: DrizzleDb,
  chatIds: ReadonlyArray<number>,
  userId: number,
): Effect.Effect<Map<number, number>> =>
  chatIds.length === 0
    ? Effect.succeed(new Map())
    : Effect.tryPromise(() =>
        db
          .select({ chatId: messages.chatId, total: count() })
          .from(messages)
          .leftJoin(
            messageReads,
            and(
              eq(messageReads.messageId, messages.id),
              eq(messageReads.userId, userId),
            ),
          )
          .where(
            and(
              inArray(messages.chatId, chatIds),
              ne(messages.senderId, userId),
              isNull(messageReads.id),
            ),
          )
          .groupBy(messages.chatId),
      ).pipe(
        Effect.orDie,
        Effect.map((rows) => new Map(rows.map((r) => [r.chatId, r.total]))),
      );

const isParticipant = (
  db: DrizzleDb,
  chatId: number,
  userId: number,
): Effect.Effect<boolean> =>
  Effect.tryPromise(() =>
    db
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, userId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows.length > 0),
  );

const getChatOr404 = (
  db: DrizzleDb,
  id: number,
): Effect.Effect<DbChat, NotFound> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      db.select().from(chats).where(eq(chats.id, id)).limit(1),
    ).pipe(Effect.orDie);
    const row = rows[0];
    if (!row)
      return yield* Effect.fail(
        new NotFound({ message: `Chat ${id} not found` }),
      );
    return row;
  });

const requireParticipant = (db: DrizzleDb, chatId: number, userId: number) =>
  Effect.gen(function* () {
    const participant = yield* isParticipant(db, chatId, userId);
    if (!participant)
      return yield* Effect.fail(
        new Forbidden({ message: "You are not a participant in this chat" }),
      );
  });

// `participants`, if passed, is used as-is instead of re-fetching — callers
// that already have a fresh list (e.g. because they just notified over the
// websocket) can reuse it rather than paying for the join twice.
const buildChat = (
  db: DrizzleDb,
  row: DbChat,
  currentUserId: number,
  participants?: ReadonlyArray<ChatParticipant>,
): Effect.Effect<Chat> =>
  Effect.gen(function* () {
    const resolvedParticipants =
      participants ?? (yield* getParticipants(db, row.id));
    const lastMessage = yield* getLastMessage(db, row.id);
    const unreadCount = yield* getUnreadCount(db, row.id, currentUserId);
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      createdBy: row.createdBy,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      participants: [...resolvedParticipants],
      lastMessage,
      unreadCount,
    };
  });

const existingUserIds = (
  db: DrizzleDb,
  ids: ReadonlyArray<number>,
): Effect.Effect<Set<number>> =>
  ids.length === 0
    ? Effect.succeed(new Set())
    : Effect.tryPromise(() =>
        db.select({ id: users.id }).from(users).where(inArray(users.id, ids)),
      ).pipe(
        Effect.orDie,
        Effect.map((rows) => new Set(rows.map((r) => r.id))),
      );

export const ChatsHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "chats",
  (handlers) =>
    handlers
      .handle("listChats", () =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({
                id: chats.id,
                type: chats.type,
                title: chats.title,
                createdBy: chats.createdBy,
                createdAt: chats.createdAt,
                updatedAt: chats.updatedAt,
              })
              .from(chats)
              .innerJoin(
                chatParticipants,
                and(
                  eq(chatParticipants.chatId, chats.id),
                  eq(chatParticipants.userId, currentUser.id),
                ),
              )
              .orderBy(desc(chats.updatedAt)),
          ).pipe(Effect.orDie);

          const chatIds = rows.map((row) => row.id);
          const [participantsByChat, lastMessageByChat, unreadByChat] =
            yield* Effect.all([
              getParticipantsForChats(db, chatIds),
              getLastMessagesForChats(db, chatIds),
              getUnreadCountsForChats(db, chatIds, currentUser.id),
            ]);

          return rows.map((row) => ({
            id: row.id,
            type: row.type,
            title: row.title,
            createdBy: row.createdBy,
            createdAt: row.createdAt.getTime(),
            updatedAt: row.updatedAt.getTime(),
            participants: participantsByChat.get(row.id) ?? [],
            lastMessage: lastMessageByChat.get(row.id) ?? null,
            unreadCount: unreadByChat.get(row.id) ?? 0,
          }));
        }),
      )
      .handle("getChat", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const row = yield* getChatOr404(db, id);
          yield* requireParticipant(db, id, currentUser.id);
          return yield* buildChat(db, row, currentUser.id);
        }),
      )
      .handle("createDirectChat", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;

          if (payload.userId === currentUser.id)
            return yield* Effect.fail(
              new InvalidChatRequest({
                message: "You can't start a chat with yourself",
              }),
            );

          const otherExists = yield* existingUserIds(db, [payload.userId]);
          if (!otherExists.has(payload.userId))
            return yield* Effect.fail(
              new NotFound({ message: `User ${payload.userId} not found` }),
            );

          // The "does a direct chat for this pair already exist" check and
          // the "create one if not" insert run inside a single `serializable`
          // transaction. Two concurrent requests for the same pair would
          // otherwise both see "no existing chat" and both create one; under
          // `serializable` isolation Postgres instead aborts one of them with
          // a serialization failure (surfaced here as a die, same as any
          // other unexpected DB error) rather than letting it silently race.
          const chatRow = yield* Effect.tryPromise(() =>
            db.transaction(
              async (tx) => {
                // A direct chat always has exactly the two participants it
                // was created with, so matching on "both ids are
                // participants of some direct chat, and it has exactly two
                // participants" uniquely identifies the (at most one)
                // existing chat for this pair.
                const existing = await tx
                  .select({ chatId: chatParticipants.chatId })
                  .from(chatParticipants)
                  .innerJoin(chats, eq(chats.id, chatParticipants.chatId))
                  .where(
                    and(
                      eq(chats.type, "direct"),
                      inArray(chatParticipants.userId, [
                        currentUser.id,
                        payload.userId,
                      ]),
                    ),
                  )
                  .groupBy(chatParticipants.chatId)
                  .having(eq(count(chatParticipants.userId), 2));

                if (existing[0]) {
                  const rows = await tx
                    .select()
                    .from(chats)
                    .where(eq(chats.id, existing[0].chatId));
                  const row = rows[0];
                  if (!row)
                    throw new Error("Existing chat vanished mid-transaction");
                  return row;
                }

                const now = new Date();
                const created = await tx
                  .insert(chats)
                  .values({
                    type: "direct",
                    title: null,
                    createdBy: currentUser.id,
                    createdAt: now,
                    updatedAt: now,
                  })
                  .returning();
                const newRow = created[0];
                if (!newRow) throw new Error("INSERT returned no rows");

                await tx.insert(chatParticipants).values([
                  {
                    chatId: newRow.id,
                    userId: currentUser.id,
                    joinedAt: now,
                  },
                  {
                    chatId: newRow.id,
                    userId: payload.userId,
                    joinedAt: now,
                  },
                ]);

                return newRow;
              },
              { isolationLevel: "serializable" },
            ),
          ).pipe(Effect.orDie);

          const participants = yield* getParticipants(db, chatRow.id);
          yield* notifyChatUpdated(
            connections,
            chatRow.id,
            participants.map((p) => p.userId),
          );
          return yield* buildChat(db, chatRow, currentUser.id, participants);
        }),
      )
      .handle("createGroupChat", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;

          const uniqueIds = new Set(payload.participantIds);
          if (uniqueIds.size !== payload.participantIds.length)
            return yield* Effect.fail(
              new InvalidChatRequest({
                message: "Participant list contains duplicates",
              }),
            );
          if (uniqueIds.has(currentUser.id))
            return yield* Effect.fail(
              new InvalidChatRequest({
                message: "You're added to the chat automatically",
              }),
            );
          if (uniqueIds.size + 1 > MAX_GROUP_PARTICIPANTS)
            return yield* Effect.fail(
              new InvalidChatRequest({
                message: `Group chats can have at most ${MAX_GROUP_PARTICIPANTS} participants`,
              }),
            );

          const found = yield* existingUserIds(db, [...uniqueIds]);
          const missing = [...uniqueIds].filter((id) => !found.has(id));
          if (missing.length > 0)
            return yield* Effect.fail(
              new NotFound({
                message: `User${missing.length > 1 ? "s" : ""} ${missing.join(", ")} not found`,
              }),
            );

          const now = new Date();
          const created = yield* Effect.tryPromise(() =>
            db
              .insert(chats)
              .values({
                type: "group",
                title: payload.title,
                createdBy: currentUser.id,
                createdAt: now,
                updatedAt: now,
              })
              .returning(),
          ).pipe(Effect.orDie);
          const chatRow = created[0];
          if (!chatRow)
            return yield* Effect.die(new Error("INSERT returned no rows"));

          yield* Effect.tryPromise(() =>
            db.insert(chatParticipants).values(
              [currentUser.id, ...uniqueIds].map((userId) => ({
                chatId: chatRow.id,
                userId,
                joinedAt: now,
              })),
            ),
          ).pipe(Effect.orDie);

          const participants = yield* getParticipants(db, chatRow.id);
          yield* notifyChatUpdated(
            connections,
            chatRow.id,
            participants.map((p) => p.userId),
          );
          return yield* buildChat(db, chatRow, currentUser.id, participants);
        }),
      )
      .handle("updateChat", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const existing = yield* getChatOr404(db, id);
          if (existing.type !== "group")
            return yield* Effect.fail(
              new InvalidChatRequest({
                message: "Only group chats can be renamed",
              }),
            );
          if (existing.createdBy !== currentUser.id)
            return yield* Effect.fail(
              new Forbidden({
                message: "Only the creator can rename this chat",
              }),
            );

          const updated = yield* Effect.tryPromise(() =>
            db
              .update(chats)
              .set({ title: payload.title })
              .where(eq(chats.id, id))
              .returning(),
          ).pipe(Effect.orDie);
          const row = updated[0];
          if (!row)
            return yield* Effect.die(new Error("UPDATE returned no rows"));
          const participants = yield* getParticipants(db, id);
          yield* notifyChatUpdated(
            connections,
            id,
            participants.map((p) => p.userId),
          );
          return yield* buildChat(db, row, currentUser.id, participants);
        }),
      )
      .handle("addParticipants", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const existing = yield* getChatOr404(db, id);
          if (existing.type !== "group")
            return yield* Effect.fail(
              new InvalidChatRequest({
                message: "Only group chats can have participants added",
              }),
            );
          if (existing.createdBy !== currentUser.id)
            return yield* Effect.fail(
              new Forbidden({
                message: "Only the creator can add participants",
              }),
            );

          // Existence-check the requested users up front — unrelated to the
          // cap race below, so it doesn't need to be inside the transaction.
          const requestedIds = [...new Set(payload.participantIds)];
          const found = yield* existingUserIds(db, requestedIds);
          const missing = requestedIds.filter((userId) => !found.has(userId));
          if (missing.length > 0)
            return yield* Effect.fail(
              new NotFound({
                message: `User${missing.length > 1 ? "s" : ""} ${missing.join(", ")} not found`,
              }),
            );

          // Recomputing who's already a participant and enforcing the group
          // cap has to happen in the same `serializable` transaction as the
          // insert — otherwise two concurrent addParticipants calls could
          // each read the same (still-under-cap) participant count before
          // either insert commits, and together push the group over
          // MAX_GROUP_PARTICIPANTS. `onConflictDoNothing` also guards
          // against re-adding someone a concurrent call just added.
          const result = yield* Effect.tryPromise(() =>
            db.transaction(
              async (tx) => {
                const currentParticipants = await tx
                  .select({ userId: chatParticipants.userId })
                  .from(chatParticipants)
                  .where(eq(chatParticipants.chatId, id));
                const currentIds = new Set(
                  currentParticipants.map((p) => p.userId),
                );
                const newIds = requestedIds.filter(
                  (userId) => !currentIds.has(userId),
                );

                if (currentIds.size + newIds.length > MAX_GROUP_PARTICIPANTS)
                  return { ok: false as const };

                if (newIds.length > 0) {
                  const now = new Date();
                  await tx
                    .insert(chatParticipants)
                    .values(
                      newIds.map((userId) => ({
                        chatId: id,
                        userId,
                        joinedAt: now,
                      })),
                    )
                    .onConflictDoNothing();
                }
                return { ok: true as const };
              },
              { isolationLevel: "serializable" },
            ),
          ).pipe(Effect.orDie);

          if (!result.ok)
            return yield* Effect.fail(
              new InvalidChatRequest({
                message: `Group chats can have at most ${MAX_GROUP_PARTICIPANTS} participants`,
              }),
            );

          const participants = yield* getParticipants(db, id);
          yield* notifyChatUpdated(
            connections,
            id,
            participants.map((p) => p.userId),
          );
          return yield* buildChat(db, existing, currentUser.id, participants);
        }),
      )
      .handle("listMessages", ({ path: { id }, urlParams }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          yield* getChatOr404(db, id);
          yield* requireParticipant(db, id, currentUser.id);

          const offset = urlParams.offset ?? 0;
          const limit = urlParams.limit ?? DEFAULT_MESSAGES_LIMIT;
          const rows = yield* Effect.tryPromise(() =>
            db
              .select()
              .from(messages)
              .where(eq(messages.chatId, id))
              .orderBy(messages.id)
              .limit(limit)
              .offset(offset),
          ).pipe(Effect.orDie);
          const totalRows = yield* Effect.tryPromise(() =>
            db
              .select({ total: count() })
              .from(messages)
              .where(eq(messages.chatId, id)),
          ).pipe(Effect.orDie);
          const total = totalRows[0]?.total ?? 0;

          const messageIds = rows.map((r) => r.id);
          const readRows =
            messageIds.length === 0
              ? []
              : yield* Effect.tryPromise(() =>
                  db
                    .select({
                      messageId: messageReads.messageId,
                      userId: messageReads.userId,
                    })
                    .from(messageReads)
                    .where(inArray(messageReads.messageId, messageIds)),
                ).pipe(Effect.orDie);
          const readersByMessage = new Map<number, number[]>();
          for (const r of readRows) {
            const list = readersByMessage.get(r.messageId) ?? [];
            list.push(r.userId);
            readersByMessage.set(r.messageId, list);
          }

          return {
            messages: rows.map((row) =>
              toApiMessage(row, readersByMessage.get(row.id) ?? []),
            ),
            offset,
            limit,
            total,
          };
        }),
      )
      .handle("createMessage", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          yield* getChatOr404(db, id);
          yield* requireParticipant(db, id, currentUser.id);

          // Inserting the message and bumping the parent chat's `updatedAt`
          // (which `listChats` sorts by) are done as one atomic statement via
          // a writable CTE, rather than two separate un-transacted round
          // trips — Postgres always runs a data-modifying CTE to completion
          // even though only `inserted`'s output is selected here, and a
          // single statement is atomic without needing an explicit
          // transaction.
          const now = new Date();
          const inserted = db.$with("inserted").as(
            db
              .insert(messages)
              .values({
                chatId: id,
                senderId: currentUser.id,
                contentType: payload.contentType,
                content: payload.content,
                createdAt: now,
                updatedAt: now,
              })
              .returning(),
          );
          const touched = db
            .$with("touched")
            .as(
              db
                .update(chats)
                .set({ updatedAt: now })
                .where(eq(chats.id, id))
                .returning({ id: chats.id }),
            );
          const created = yield* Effect.tryPromise(() =>
            db.with(inserted, touched).select().from(inserted),
          ).pipe(Effect.orDie);
          const row = created[0];
          if (!row)
            return yield* Effect.die(new Error("INSERT returned no rows"));

          const participants = yield* getParticipants(db, id);
          yield* notifyChatUpdated(
            connections,
            id,
            participants.map((p) => p.userId),
          );
          return toApiMessage(row, []);
        }),
      )
      .handle("markRead", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const chatRow = yield* getChatOr404(db, id);
          yield* requireParticipant(db, id, currentUser.id);

          const target = yield* Effect.tryPromise(() =>
            db
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(
                  eq(messages.chatId, id),
                  eq(messages.id, payload.messageId),
                ),
              )
              .limit(1),
          ).pipe(Effect.orDie);
          if (!target[0])
            return yield* Effect.fail(
              new NotFound({
                message: `Message ${payload.messageId} not found in chat ${id}`,
              }),
            );

          const unreadUpTo = yield* Effect.tryPromise(() =>
            db
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(
                  eq(messages.chatId, id),
                  ne(messages.senderId, currentUser.id),
                  lte(messages.id, payload.messageId),
                ),
              ),
          ).pipe(Effect.orDie);

          if (unreadUpTo.length > 0) {
            const now = new Date();
            yield* Effect.tryPromise(() =>
              db
                .insert(messageReads)
                .values(
                  unreadUpTo.map((m) => ({
                    messageId: m.id,
                    userId: currentUser.id,
                    readAt: now,
                  })),
                )
                .onConflictDoNothing(),
            ).pipe(Effect.orDie);
          }

          const participants = yield* getParticipants(db, id);
          if (unreadUpTo.length > 0) {
            yield* notifyChatUpdated(
              connections,
              id,
              participants.map((p) => p.userId),
            );
          }
          return yield* buildChat(db, chatRow, currentUser.id, participants);
        }),
      ),
);
