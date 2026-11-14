import { and, desc, eq, notInArray } from "drizzle-orm";
import { Effect, Metric } from "effect";
import {
  GAME_CHAT_PAGE_SIZE,
  TooManyRequests,
  type GameChatMessage,
} from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import { gameLobbyMessages, users } from "../db/schema.ts";
import { rateLimitRejectionsTotal } from "../Metrics.ts";
import { blockedOrMutedUserIds } from "../blocks.ts";
import { RateLimiter } from "../RateLimiter.ts";
import { gameLobbyRoom } from "../Realtime.ts";

import { type GamesDeps, type GamesHandlers } from "./handlerKit.ts";
import {
  chatOpenFor,
  invalid,
  loadLobbyOr404,
  loadSnapshot,
} from "./lobbyStore.ts";
import { publicUserColumns, toPublicUser } from "../users/userViews.ts";

// A lobby's chat fans every line out to the whole room, so a per-user cap
// keeps one flooder from drowning it — roomy for a lively conversation.
const GAME_CHAT_MAX_PER_USER = 10;

const GAME_CHAT_WINDOW_SECONDS = 15;

const enforceChatLimit = (limiter: RateLimiter["Service"], userId: number) =>
  Effect.gen(function* () {
    const result = yield* limiter.consume(
      `games:chat:user:${userId}`,
      GAME_CHAT_MAX_PER_USER,
      GAME_CHAT_WINDOW_SECONDS,
    );
    if (!result.allowed) {
      yield* Metric.update(
        Metric.withAttributes(rateLimitRejectionsTotal, {
          limiter: "game_chat",
        }),
        1,
      );
      return yield* Effect.fail(
        new TooManyRequests({
          message: "You're chatting too fast. Take a breath and try again.",
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
    }
  });

const toApiChatMessage = (row: {
  readonly id: number;
  readonly lobbyId: number;
  readonly text: string;
  readonly createdAt: Date;
  readonly user: Parameters<typeof toPublicUser>[0];
}): GameChatMessage => ({
  id: row.id,
  lobbyId: row.lobbyId,
  user: toPublicUser(row.user),
  text: row.text,
  createdAt: row.createdAt.getTime(),
});

export const lobbyChatHandlers = ({ limiter, db, connections }: GamesDeps) =>
  ({
    listGameChat: ({ params: { id } }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        yield* loadLobbyOr404(db, id);
        const hidden = yield* Effect.tryPromise(() =>
          blockedOrMutedUserIds(db, currentUser.id),
        ).pipe(Effect.orDie);
        const rows = yield* Effect.tryPromise(() =>
          db
            .select({
              id: gameLobbyMessages.id,
              lobbyId: gameLobbyMessages.lobbyId,
              text: gameLobbyMessages.text,
              createdAt: gameLobbyMessages.createdAt,
              user: publicUserColumns,
            })
            .from(gameLobbyMessages)
            .innerJoin(users, eq(users.id, gameLobbyMessages.userId))
            .where(
              and(
                eq(gameLobbyMessages.lobbyId, id),
                hidden.length > 0
                  ? notInArray(gameLobbyMessages.userId, hidden)
                  : undefined,
              ),
            )
            .orderBy(desc(gameLobbyMessages.id))
            .limit(GAME_CHAT_PAGE_SIZE),
        ).pipe(Effect.orDie);
        return { messages: rows.reverse().map(toApiChatMessage) };
      }),
    postGameChat: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const snapshot = yield* loadSnapshot(db, id);
        if (!chatOpenFor(snapshot)) {
          return yield* invalid(
            "Chat is paused while the game is in play — reactions still work!",
          );
        }
        yield* enforceChatLimit(limiter, currentUser.id);
        const [row] = yield* Effect.tryPromise(() =>
          db
            .insert(gameLobbyMessages)
            .values({
              lobbyId: id,
              userId: currentUser.id,
              text: payload.text,
            })
            .returning(),
        ).pipe(Effect.orDie);
        const [author] = yield* Effect.tryPromise(() =>
          db
            .select(publicUserColumns)
            .from(users)
            .where(eq(users.id, currentUser.id))
            .limit(1),
        ).pipe(Effect.orDie);
        yield* connections.notifyRoom(gameLobbyRoom(id), {
          type: "game_chat",
          lobbyId: id,
        });
        return toApiChatMessage({ ...row!, user: author! });
      }),
  }) satisfies GamesHandlers;
