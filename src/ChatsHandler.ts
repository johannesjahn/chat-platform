import { HttpApiBuilder } from "@effect/platform";
import { and, count, desc, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import { Effect } from "effect";
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
  Effect.try(() =>
    db
      .select({ userId: chatParticipants.userId, username: users.username })
      .from(chatParticipants)
      .innerJoin(users, eq(users.id, chatParticipants.userId))
      .where(eq(chatParticipants.chatId, chatId))
      .all(),
  ).pipe(Effect.orDie);

const getLastMessage = (
  db: DrizzleDb,
  chatId: number,
): Effect.Effect<Message | null> =>
  Effect.gen(function* () {
    const rows = yield* Effect.try(() =>
      db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(desc(messages.id))
        .limit(1)
        .all(),
    ).pipe(Effect.orDie);
    const row = rows[0];
    if (!row) return null;
    const readers = yield* Effect.try(() =>
      db
        .select({ userId: messageReads.userId })
        .from(messageReads)
        .where(eq(messageReads.messageId, row.id))
        .all(),
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
  Effect.try(() => {
    const rows = db
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
      )
      .all();
    return rows[0]?.total ?? 0;
  }).pipe(Effect.orDie);

const isParticipant = (
  db: DrizzleDb,
  chatId: number,
  userId: number,
): Effect.Effect<boolean> =>
  Effect.try(() =>
    db
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, userId),
        ),
      )
      .limit(1)
      .all(),
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows.length > 0),
  );

const getChatOr404 = (
  db: DrizzleDb,
  id: number,
): Effect.Effect<DbChat, NotFound> =>
  Effect.gen(function* () {
    const rows = yield* Effect.try(() =>
      db.select().from(chats).where(eq(chats.id, id)).limit(1).all(),
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

const buildChat = (
  db: DrizzleDb,
  row: DbChat,
  currentUserId: number,
): Effect.Effect<Chat> =>
  Effect.gen(function* () {
    const participants = yield* getParticipants(db, row.id);
    const lastMessage = yield* getLastMessage(db, row.id);
    const unreadCount = yield* getUnreadCount(db, row.id, currentUserId);
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      createdBy: row.createdBy,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      participants: [...participants],
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
    : Effect.try(() =>
        db
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, ids))
          .all(),
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
          const rows = yield* Effect.try(() =>
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
              .orderBy(desc(chats.updatedAt))
              .all(),
          ).pipe(Effect.orDie);
          return yield* Effect.all(
            rows.map((row) => buildChat(db, row, currentUser.id)),
          );
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

          // A direct chat always has exactly the two participants it was
          // created with, so matching on "both ids are participants of some
          // direct chat, and it has exactly two participants" uniquely
          // identifies the (at most one) existing chat for this pair.
          const existing = yield* Effect.try(() =>
            db
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
              .having(eq(count(chatParticipants.userId), 2))
              .all(),
          ).pipe(Effect.orDie);

          if (existing[0]) {
            const row = yield* getChatOr404(db, existing[0].chatId);
            return yield* buildChat(db, row, currentUser.id);
          }

          const now = new Date();
          const created = yield* Effect.try(() =>
            db
              .insert(chats)
              .values({
                type: "direct",
                title: null,
                createdBy: currentUser.id,
                createdAt: now,
                updatedAt: now,
              })
              .returning()
              .all(),
          ).pipe(Effect.orDie);
          const chatRow = created[0];
          if (!chatRow)
            return yield* Effect.die(new Error("INSERT returned no rows"));

          yield* Effect.try(() =>
            db
              .insert(chatParticipants)
              .values([
                { chatId: chatRow.id, userId: currentUser.id, joinedAt: now },
                { chatId: chatRow.id, userId: payload.userId, joinedAt: now },
              ])
              .run(),
          ).pipe(Effect.orDie);

          return yield* buildChat(db, chatRow, currentUser.id);
        }),
      )
      .handle("createGroupChat", ({ payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;

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
          const created = yield* Effect.try(() =>
            db
              .insert(chats)
              .values({
                type: "group",
                title: payload.title,
                createdBy: currentUser.id,
                createdAt: now,
                updatedAt: now,
              })
              .returning()
              .all(),
          ).pipe(Effect.orDie);
          const chatRow = created[0];
          if (!chatRow)
            return yield* Effect.die(new Error("INSERT returned no rows"));

          yield* Effect.try(() =>
            db
              .insert(chatParticipants)
              .values(
                [currentUser.id, ...uniqueIds].map((userId) => ({
                  chatId: chatRow.id,
                  userId,
                  joinedAt: now,
                })),
              )
              .run(),
          ).pipe(Effect.orDie);

          return yield* buildChat(db, chatRow, currentUser.id);
        }),
      )
      .handle("updateChat", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
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

          const updated = yield* Effect.try(() =>
            db
              .update(chats)
              .set({ title: payload.title })
              .where(eq(chats.id, id))
              .returning()
              .all(),
          ).pipe(Effect.orDie);
          const row = updated[0];
          if (!row)
            return yield* Effect.die(new Error("UPDATE returned no rows"));
          return yield* buildChat(db, row, currentUser.id);
        }),
      )
      .handle("addParticipants", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
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

          const currentParticipants = yield* getParticipants(db, id);
          const currentIds = new Set(currentParticipants.map((p) => p.userId));
          const newIds = [...new Set(payload.participantIds)].filter(
            (userId) => !currentIds.has(userId),
          );

          if (currentIds.size + newIds.length > MAX_GROUP_PARTICIPANTS)
            return yield* Effect.fail(
              new InvalidChatRequest({
                message: `Group chats can have at most ${MAX_GROUP_PARTICIPANTS} participants`,
              }),
            );

          if (newIds.length > 0) {
            const found = yield* existingUserIds(db, newIds);
            const missing = newIds.filter((userId) => !found.has(userId));
            if (missing.length > 0)
              return yield* Effect.fail(
                new NotFound({
                  message: `User${missing.length > 1 ? "s" : ""} ${missing.join(", ")} not found`,
                }),
              );

            const now = new Date();
            yield* Effect.try(() =>
              db
                .insert(chatParticipants)
                .values(
                  newIds.map((userId) => ({
                    chatId: id,
                    userId,
                    joinedAt: now,
                  })),
                )
                .run(),
            ).pipe(Effect.orDie);
          }

          return yield* buildChat(db, existing, currentUser.id);
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
          const rows = yield* Effect.try(() =>
            db
              .select()
              .from(messages)
              .where(eq(messages.chatId, id))
              .orderBy(messages.id)
              .limit(limit)
              .offset(offset)
              .all(),
          ).pipe(Effect.orDie);
          const totalRows = yield* Effect.try(() =>
            db
              .select({ total: count() })
              .from(messages)
              .where(eq(messages.chatId, id))
              .all(),
          ).pipe(Effect.orDie);
          const total = totalRows[0]?.total ?? 0;

          const messageIds = rows.map((r) => r.id);
          const readRows =
            messageIds.length === 0
              ? []
              : yield* Effect.try(() =>
                  db
                    .select({
                      messageId: messageReads.messageId,
                      userId: messageReads.userId,
                    })
                    .from(messageReads)
                    .where(inArray(messageReads.messageId, messageIds))
                    .all(),
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
          yield* getChatOr404(db, id);
          yield* requireParticipant(db, id, currentUser.id);

          const now = new Date();
          const created = yield* Effect.try(() =>
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
              .returning()
              .all(),
          ).pipe(Effect.orDie);
          const row = created[0];
          if (!row)
            return yield* Effect.die(new Error("INSERT returned no rows"));

          yield* Effect.try(() =>
            db
              .update(chats)
              .set({ updatedAt: now })
              .where(eq(chats.id, id))
              .run(),
          ).pipe(Effect.orDie);

          return toApiMessage(row, []);
        }),
      )
      .handle("markRead", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const chatRow = yield* getChatOr404(db, id);
          yield* requireParticipant(db, id, currentUser.id);

          const target = yield* Effect.try(() =>
            db
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(
                  eq(messages.chatId, id),
                  eq(messages.id, payload.messageId),
                ),
              )
              .limit(1)
              .all(),
          ).pipe(Effect.orDie);
          if (!target[0])
            return yield* Effect.fail(
              new NotFound({
                message: `Message ${payload.messageId} not found in chat ${id}`,
              }),
            );

          const unreadUpTo = yield* Effect.try(() =>
            db
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(
                  eq(messages.chatId, id),
                  ne(messages.senderId, currentUser.id),
                  lte(messages.id, payload.messageId),
                ),
              )
              .all(),
          ).pipe(Effect.orDie);

          if (unreadUpTo.length > 0) {
            const now = new Date();
            yield* Effect.try(() =>
              db
                .insert(messageReads)
                .values(
                  unreadUpTo.map((m) => ({
                    messageId: m.id,
                    userId: currentUser.id,
                    readAt: now,
                  })),
                )
                .onConflictDoNothing()
                .run(),
            ).pipe(Effect.orDie);
          }

          return yield* buildChat(db, chatRow, currentUser.id);
        }),
      ),
);
