import { and, count, eq, gt, lte, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { NotFound } from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import { chatParticipants, messageReads, messages } from "../db/schema.ts";
import { type ChatsDeps, type ChatsHandlers } from "./handlerKit.ts";
import {
  getChatOr404,
  isAcceptedParticipant,
  requireParticipant,
} from "./access.ts";
import {
  buildChat,
  bumpChatVersion,
  getParticipants,
  notifyChatUpdated,
} from "./chatState.ts";
import { getUnreadTotal } from "./unread.ts";

export const readHandlers = ({ db, storage, connections }: ChatsDeps) =>
  ({
    getUnreadChatCount: () =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        return yield* getUnreadTotal(db, currentUser.id);
      }),
    markRead: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const chatRow = yield* getChatOr404(db, id);
        yield* requireParticipant(db, id, currentUser.id);

        const target = yield* Effect.tryPromise(() =>
          db
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(eq(messages.chatId, id), eq(messages.id, payload.messageId)),
            )
            .limit(1),
        ).pipe(Effect.orDie);
        if (!target[0])
          return yield* Effect.fail(
            new NotFound({
              message: `Message ${payload.messageId} not found in chat ${id}`,
            }),
          );

        // Reading a message request to decide on it (issue #808) sends no
        // read receipt: that would tell whoever added the reader that
        // they've looked, as if they'd joined. So it's a no-op that
        // answers like one; the watermark starts moving once accepted.
        if (!(yield* isAcceptedParticipant(db, id, currentUser.id)))
          return yield* buildChat(db, storage, chatRow, currentUser.id);

        // Move the reader's watermark forward to the target (issue #659) —
        // never back, so re-reading an older message is a no-op. The
        // `previous` self-join returns the watermark it replaced, which
        // bounds the newly read range below.
        const previous = alias(chatParticipants, "previous");
        const advanced = yield* Effect.tryPromise(() =>
          db
            .update(chatParticipants)
            .set({ lastReadMessageId: payload.messageId })
            .from(previous)
            .where(
              and(
                eq(previous.id, chatParticipants.id),
                eq(chatParticipants.chatId, id),
                eq(chatParticipants.userId, currentUser.id),
                sql`coalesce(${chatParticipants.lastReadMessageId}, 0) < ${payload.messageId}`,
              ),
            )
            .returning({ previous: previous.lastReadMessageId }),
        ).pipe(Effect.orDie);

        // Only messages from others past the old watermark are newly read,
        // so the work is bounded by what was unread, not the history
        // (issue #648). If none of them is from anyone else, no unread
        // count or receipt changed, so nothing is bumped or published.
        let newlyRead = 0;
        if (advanced[0]) {
          const newlyReadRange = and(
            eq(messages.chatId, id),
            ne(messages.senderId, currentUser.id),
            gt(messages.id, advanced[0].previous ?? 0),
            lte(messages.id, payload.messageId),
          );
          const counted = yield* Effect.tryPromise(() =>
            db.select({ total: count() }).from(messages).where(newlyReadRange),
          ).pipe(Effect.orDie);
          newlyRead = counted[0]?.total ?? 0;
          // Expand phase: keep `message_reads` written for replicas still
          // on the previous release, which read receipts from it. One
          // INSERT … SELECT, so there's no bind-parameter limit to hit.
          if (newlyRead > 0) {
            yield* Effect.tryPromise(() =>
              db.execute(sql`
                  INSERT INTO ${messageReads} (message_id, user_id, read_at)
                  SELECT ${messages.id}, ${currentUser.id}, now()
                  FROM ${messages}
                  WHERE ${newlyReadRange}
                  ON CONFLICT DO NOTHING
                `),
            ).pipe(Effect.orDie);
          }
        }

        const participants = yield* getParticipants(db, id);
        let version = chatRow.version;
        if (newlyRead > 0) {
          version = yield* bumpChatVersion(db, id);
          // A receipt the other participants patch in place, not a bare
          // "something changed" that sent every one of them off to
          // refetch the chat list, the chat and its message window: N
          // readers doing that to N viewers made each group message cost
          // O(N²) requests (issue #749).
          yield* notifyChatUpdated(
            connections,
            id,
            version,
            participants.map((p) => p.userId),
            {
              change: "read",
              userId: currentUser.id,
              fromMessageId: advanced[0]?.previous ?? 0,
              lastReadMessageId: payload.messageId,
            },
          );
        }
        return yield* buildChat(
          db,
          storage,
          { ...chatRow, version },
          currentUser.id,
          participants,
        );
      }),
  }) satisfies ChatsHandlers;
