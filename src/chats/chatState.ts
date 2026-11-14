import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  type Chat,
  type ChatParticipant,
  type MessageRequest,
} from "../Api.ts";
import { AttachmentStorage } from "../AttachmentStorage.ts";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import { type ChatChange, RealtimeConnections } from "../Realtime.ts";

import { chatParticipants, chats, users, type DbChat } from "../db/schema.ts";
import { getLastMessage } from "./messageViews.ts";
import { getUnreadCount } from "./unread.ts";
import { toAvatarVariants } from "../avatars.ts";
import { effectiveStatus } from "../users/userViews.ts";

// Chat rows as clients see them: participants, the per-chat `version` and
// its `chat_updated` publish, and the full `Chat` view (`buildChat`).

export const getParticipants = (
  db: DrizzleDb,
  chatId: number,
): Effect.Effect<ReadonlyArray<ChatParticipant>> =>
  dbQuery(() =>
    db
      .select({
        userId: chatParticipants.userId,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        avatarSmallKey: users.avatarSmallKey,
        avatarMediumKey: users.avatarMediumKey,
        avatarLargeKey: users.avatarLargeKey,
        role: chatParticipants.role,
        statusText: users.statusText,
        statusEmoji: users.statusEmoji,
        statusExpiresAt: users.statusExpiresAt,
      })
      .from(chatParticipants)
      .innerJoin(users, eq(users.id, chatParticipants.userId))
      .where(eq(chatParticipants.chatId, chatId)),
  ).pipe(
    Effect.map((rows) =>
      rows.map(
        ({
          avatarSmallKey,
          avatarMediumKey,
          avatarLargeKey,
          statusText,
          statusEmoji,
          statusExpiresAt,
          ...rest
        }) => ({
          ...rest,
          avatarVariants: toAvatarVariants({
            avatarSmallKey,
            avatarMediumKey,
            avatarLargeKey,
          }),
          ...effectiveStatus({ statusText, statusEmoji, statusExpiresAt }),
        }),
      ),
    ),
  );

// Increments `chats.version` for every participant-visible mutation other
// than chat creation (a freshly-created chat's row already carries its
// initial version, so creation just publishes that as-is — see
// `createDirectChat`/`createGroupChat`). `createMessage` is the one
// exception among mutation call sites: it already updates `chats.updatedAt`
// atomically alongside the message insert (see the `touched` CTE in
// `insertMessage`, sendPath.ts), so it folds the version bump into that same
// statement instead of paying for a second UPDATE, and reads the result back
// with `getChatVersion`.
export const bumpChatVersion = (
  db: DrizzleDb,
  chatId: number,
): Effect.Effect<number> =>
  dbQuery(() =>
    db
      .update(chats)
      .set({ version: sql`${chats.version} + 1` })
      .where(eq(chats.id, chatId))
      .returning({ version: chats.version }),
  ).pipe(Effect.map((rows) => rows[0]?.version ?? 0));

export const getChatVersion = (
  db: DrizzleDb,
  chatId: number,
): Effect.Effect<number> =>
  dbQuery(() =>
    db
      .select({ version: chats.version })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1),
  ).pipe(Effect.map((rows) => rows[0]?.version ?? 0));

// Pushes a `chat_updated` event to every current participant of `chatId` so
// their chat list / open conversation can refetch instead of polling for it.
// Takes the participant ids rather than re-deriving them from `chatId` —
// every call site already has a freshly-fetched participant list on hand for
// building its own response (see `buildChat`), so this avoids a second
// `getParticipants` round-trip per mutation. `version` is whatever the
// caller determined the chat's post-mutation version to be (see
// `bumpChatVersion`/`getChatVersion`). `change` says what happened, for the
// changes a client can act on narrowly (see `ChatChange` in Realtime.ts);
// without it the event means "refetch everything".
export const notifyChatUpdated = (
  connections: RealtimeConnections["Service"],
  chatId: number,
  version: number,
  participantUserIds: ReadonlyArray<number>,
  change?: ChatChange,
): Effect.Effect<void> =>
  connections.notifyUsers(participantUserIds, {
    type: "chat_updated",
    chatId,
    version,
    ...change,
  });

// Batched equivalents of getParticipants/getLastMessage/getUnreadCount for
// building many chats at once (e.g. listChats) — this one,
// `getLastMessagesForChats` (messageViews.ts) and `getUnreadCountsForChats`
// (unread.ts) each do one query (plus, for last-message, one extra query to
// resolve read receipts) across all `chatIds` instead of firing per-chat,
// avoiding an N+1 round trip per chat.
export const getParticipantsForChats = (
  db: DrizzleDb,
  chatIds: ReadonlyArray<number>,
): Effect.Effect<Map<number, ChatParticipant[]>> =>
  chatIds.length === 0
    ? Effect.succeed(new Map())
    : dbQuery(() =>
        db
          .select({
            chatId: chatParticipants.chatId,
            userId: chatParticipants.userId,
            username: users.username,
            displayName: users.displayName,
            avatarUrl: users.avatarUrl,
            avatarSmallKey: users.avatarSmallKey,
            avatarMediumKey: users.avatarMediumKey,
            avatarLargeKey: users.avatarLargeKey,
            role: chatParticipants.role,
            statusText: users.statusText,
            statusEmoji: users.statusEmoji,
            statusExpiresAt: users.statusExpiresAt,
          })
          .from(chatParticipants)
          .innerJoin(users, eq(users.id, chatParticipants.userId))
          .where(inArray(chatParticipants.chatId, chatIds)),
      ).pipe(
        Effect.map((rows) => {
          const byChat = new Map<number, ChatParticipant[]>();
          for (const {
            chatId,
            avatarSmallKey,
            avatarMediumKey,
            avatarLargeKey,
            statusText,
            statusEmoji,
            statusExpiresAt,
            ...participant
          } of rows) {
            const list = byChat.get(chatId) ?? [];
            list.push({
              ...participant,
              avatarVariants: toAvatarVariants({
                avatarSmallKey,
                avatarMediumKey,
                avatarLargeKey,
              }),
              ...effectiveStatus({ statusText, statusEmoji, statusExpiresAt }),
            });
            byChat.set(chatId, list);
          }
          return byChat;
        }),
      );

export const toMessageRequest = (row: {
  readonly requestPending: boolean;
  readonly addedBy: number | null;
}): MessageRequest | null =>
  row.requestPending ? { addedBy: row.addedBy } : null;

// The viewer's pending request for `chatId`, if it is one for them.
const isMessageRequestFor = (
  db: DrizzleDb,
  chatId: number,
  userId: number,
): Effect.Effect<MessageRequest | null> =>
  dbQuery(() =>
    db
      .select({
        requestPending: chatParticipants.requestPending,
        addedBy: chatParticipants.addedBy,
      })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chatId),
          eq(chatParticipants.userId, userId),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => (rows[0] ? toMessageRequest(rows[0]) : null)));

// `participants`, if passed, is used as-is instead of re-fetching — callers
// that already have a fresh list (e.g. because they just notified over the
// websocket) can reuse it rather than paying for the join twice.
export const buildChat = (
  db: DrizzleDb,
  storage: AttachmentStorage["Service"],
  row: DbChat,
  currentUserId: number,
  participants?: ReadonlyArray<ChatParticipant>,
): Effect.Effect<Chat> =>
  Effect.gen(function* () {
    const resolvedParticipants =
      participants ?? (yield* getParticipants(db, row.id));
    const lastMessage = yield* getLastMessage(
      db,
      storage,
      row.id,
      currentUserId,
    );
    const unreadCount = yield* getUnreadCount(db, row.id, currentUserId);
    const messageRequest = yield* isMessageRequestFor(
      db,
      row.id,
      currentUserId,
    );
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      createdBy: row.createdBy,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      version: row.version,
      participants: [...resolvedParticipants],
      lastMessage,
      unreadCount,
      avatarVariants: toAvatarVariants(row),
      messageRequest,
    };
  });
