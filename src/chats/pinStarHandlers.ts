import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { CurrentUser } from "../Auth.ts";
import { pinnedMessageIds, starredMessageIdsInChat } from "../pinsStars.ts";
import { pinnedMessages, starredMessages } from "../db/schema.ts";
import { type ChatsDeps, type ChatsHandlers } from "./handlerKit.ts";
import {
  getChatOr404,
  getMessageOr404,
  requireAcceptedParticipant,
  requireParticipant,
} from "./access.ts";
import { getParticipants } from "./chatState.ts";
import { buildMessageResponse, buildMessagesInOrder } from "./messageViews.ts";
import { dbQuery } from "../Db.ts";

export const pinStarHandlers = ({ db, storage, connections }: ChatsDeps) =>
  ({
    listPinnedMessages: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* getChatOr404(db, id);
        yield* requireParticipant(db, id, currentUser.id);
        const ids = yield* dbQuery(() => pinnedMessageIds(db, id));
        return yield* buildMessagesInOrder(db, storage, ids, currentUser.id);
      }),
    pinMessage: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* getChatOr404(db, id);
        yield* requireAcceptedParticipant(db, id, currentUser.id);
        // Validates the message belongs to *this* chat (a message from
        // another chat, or a nonexistent one, 404s here) and hands back the
        // row reused to build the response below.
        const row = yield* getMessageOr404(db, id, payload.messageId);
        // Idempotent: the unique index on `messageId` turns re-pinning an
        // already-pinned message into a no-op (no second row, no error),
        // same convention as `addMessageReaction`.
        const inserted = yield* dbQuery(() =>
          db
            .insert(pinnedMessages)
            .values({
              chatId: id,
              messageId: payload.messageId,
              pinnedBy: currentUser.id,
            })
            .onConflictDoNothing()
            .returning(),
        );
        if (inserted.length > 0) {
          // Scoped to the chat's participants, not broadcast — a chat and
          // its pins are private to them (see MessagePinEvent in
          // Realtime.ts).
          const participants = yield* getParticipants(db, id);
          yield* connections.notifyUsers(
            participants.map((p) => p.userId),
            {
              type: "message_pin_changed",
              chatId: id,
              messageId: payload.messageId,
              pinned: true,
            },
          );
        }
        return yield* buildMessageResponse(
          db,
          storage,
          row,
          currentUser.id,
          true,
        );
      }),
    unpinMessage: ({ params: { id, messageId } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* getChatOr404(db, id);
        yield* requireAcceptedParticipant(db, id, currentUser.id);
        const row = yield* getMessageOr404(db, id, messageId);
        const deleted = yield* dbQuery(() =>
          db
            .delete(pinnedMessages)
            .where(
              and(
                eq(pinnedMessages.chatId, id),
                eq(pinnedMessages.messageId, messageId),
              ),
            )
            .returning(),
        );
        if (deleted.length > 0) {
          const participants = yield* getParticipants(db, id);
          yield* connections.notifyUsers(
            participants.map((p) => p.userId),
            {
              type: "message_pin_changed",
              chatId: id,
              messageId,
              pinned: false,
            },
          );
        }
        return yield* buildMessageResponse(
          db,
          storage,
          row,
          currentUser.id,
          false,
        );
      }),
    listStarredMessages: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* getChatOr404(db, id);
        yield* requireParticipant(db, id, currentUser.id);
        const ids = yield* dbQuery(() =>
          starredMessageIdsInChat(db, id, currentUser.id),
        );
        return yield* buildMessagesInOrder(db, storage, ids, currentUser.id);
      }),
    starMessage: ({ params: { id, messageId } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* getChatOr404(db, id);
        yield* requireParticipant(db, id, currentUser.id);
        const row = yield* getMessageOr404(db, id, messageId);
        // Idempotent via the (userId, messageId) unique constraint. No
        // realtime event: a star is private to `currentUser` (see
        // pinsStars.ts), so there's nothing to broadcast.
        yield* dbQuery(() =>
          db
            .insert(starredMessages)
            .values({ userId: currentUser.id, messageId })
            .onConflictDoNothing(),
        );
        return yield* buildMessageResponse(
          db,
          storage,
          row,
          currentUser.id,
          undefined,
          true,
        );
      }),
    unstarMessage: ({ params: { id, messageId } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* getChatOr404(db, id);
        yield* requireParticipant(db, id, currentUser.id);
        const row = yield* getMessageOr404(db, id, messageId);
        yield* dbQuery(() =>
          db
            .delete(starredMessages)
            .where(
              and(
                eq(starredMessages.userId, currentUser.id),
                eq(starredMessages.messageId, messageId),
              ),
            ),
        );
        return yield* buildMessageResponse(
          db,
          storage,
          row,
          currentUser.id,
          undefined,
          false,
        );
      }),
  }) satisfies ChatsHandlers;
