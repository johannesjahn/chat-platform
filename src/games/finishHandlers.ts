import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Forbidden, InvalidGameRequest, type GameId } from "../Api.ts";
import { CurrentUser } from "../Auth.ts";
import {
  gameLobbies,
  gameLobbyPlayers,
  gameResults,
  type DbGameLobby,
} from "../db/schema.ts";
import { scoreReflex } from "./reflex.ts";
import { GAME_RULES, type RaceRules } from "./rules.ts";
import { type GamesDeps, type GamesHandlers } from "./handlerKit.ts";
import {
  invalid,
  loadLobbyOr404,
  loadPlayers,
  loadSnapshot,
  notifyLobbyChanged,
  touchLobby,
} from "./lobbyStore.ts";
import {
  buildLobby,
  currentRecordHolder,
  notifyRecordBroken,
} from "./settlement.ts";
import { dbQuery } from "../Db.ts";

// A finish that left the client just before `endsAt` can land a moment
// after it; this much network slack is still credited.
const FINISH_GRACE_MS = 2_000;

// The race-only rules of `lobby`'s game, or a 400 for any other game.
const requireRace = (lobby: DbGameLobby) => {
  const rules = GAME_RULES[lobby.game as GameId];
  return rules.kind === "race"
    ? Effect.succeed<RaceRules>(rules)
    : invalid("This game has no races to finish");
};

export const finishHandlers = ({ db, connections }: GamesDeps) =>
  ({
    finishRace: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const now = Date.now();
        const lobby = yield* loadLobbyOr404(db, id);
        const rules = yield* requireRace(lobby);
        const players = (yield* loadPlayers(db, [id])).get(id) ?? [];
        const me = players.find((player) => player.user.id === currentUser.id);
        if (!me) {
          return yield* Effect.fail(
            new Forbidden({ message: "You are not racing in this lobby" }),
          );
        }
        if (me.durationMs !== null) {
          return yield* Effect.fail(
            new InvalidGameRequest({ message: "You already finished" }),
          );
        }
        if (
          lobby.status !== "started" ||
          !lobby.startsAt ||
          !lobby.endsAt ||
          !lobby.passage ||
          now < lobby.startsAt.getTime()
        ) {
          return yield* Effect.fail(
            new InvalidGameRequest({ message: "The race has not started" }),
          );
        }
        if (now > lobby.endsAt.getTime() + FINISH_GRACE_MS) {
          return yield* Effect.fail(
            new InvalidGameRequest({ message: "The race is over" }),
          );
        }

        const durationMs = now - lobby.startsAt.getTime();
        const result = rules.score({
          passage: lobby.passage,
          typed: payload.typed,
          errors: payload.errors,
          durationMs,
        });
        if (!result.ok) {
          return yield* Effect.fail(
            new InvalidGameRequest({ message: result.reason }),
          );
        }

        // Guarded on "not finished yet" and on the round still being the
        // one this finish was timed against — a rematch landing in between
        // must not have this credited to the fresh round.
        const recorded = yield* dbQuery(() =>
          db
            .update(gameLobbyPlayers)
            .set({
              durationMs,
              score: result.score,
              accuracy: result.accuracy,
            })
            .where(
              and(
                eq(gameLobbyPlayers.lobbyId, id),
                eq(gameLobbyPlayers.userId, currentUser.id),
                isNull(gameLobbyPlayers.durationMs),
                sql`exists (select 1 from ${gameLobbies} where ${gameLobbies.id} = ${id} and ${gameLobbies.round} = ${lobby.round})`,
              ),
            )
            .returning({ id: gameLobbyPlayers.id }),
        );
        if (recorded.length === 0) {
          return yield* Effect.fail(
            new InvalidGameRequest({ message: "You already finished" }),
          );
        }

        // Finish time is the server's clock at acceptance, so it only ever
        // grows with arrival order and "how many finished faster" is the
        // place. Two finishes landing in the very same instant can share
        // a place — a tie is the honest outcome there anyway.
        const [faster] = yield* dbQuery(() =>
          db
            .select({ count: sql<number>`cast(count(*) as int)` })
            .from(gameLobbyPlayers)
            .where(
              and(
                eq(gameLobbyPlayers.lobbyId, id),
                lt(gameLobbyPlayers.durationMs, durationMs),
              ),
            ),
        );
        const place = (faster?.count ?? 0) + 1;
        yield* dbQuery(() =>
          db
            .update(gameLobbyPlayers)
            .set({ place })
            .where(eq(gameLobbyPlayers.id, recorded[0]!.id)),
        );
        const record = yield* currentRecordHolder(db, lobby.game);
        yield* dbQuery(() =>
          db.insert(gameResults).values({
            game: lobby.game,
            userId: currentUser.id,
            lobbyId: id,
            round: lobby.round,
            score: result.score,
            accuracy: result.accuracy,
            durationMs,
            place,
            playerCount: players.length,
          }),
        );
        yield* notifyRecordBroken({ db, connections }, lobby.game, id, record, [
          { userId: currentUser.id, score: result.score },
        ]);
        yield* touchLobby(db, id);
        yield* notifyLobbyChanged(connections, lobby);
        return yield* buildLobby({ db, connections }, id, currentUser.id);
      }),
    finishReflex: ({ params: { id }, payload }) =>
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser;
        const snapshot = yield* loadSnapshot(db, id);
        const { lobby, players, reflex, now } = snapshot;
        if (GAME_RULES[lobby.game as GameId].kind !== "reflex") {
          return yield* invalid("This isn't a Reflex Rush lobby");
        }
        const me = players.find((player) => player.user.id === currentUser.id);
        if (!me) {
          return yield* Effect.fail(
            new Forbidden({ message: "You are not playing in this lobby" }),
          );
        }
        if (me.durationMs !== null) {
          return yield* invalid("You already finished");
        }
        if (!reflex || !lobby.startsAt || !lobby.endsAt) {
          return yield* invalid("The game has not started");
        }
        const startsAt = lobby.startsAt.getTime();
        // Its last round has to have been played first — with a little
        // slack for a client clock running slightly ahead of ours.
        if (now < startsAt + reflex.closeAt - FINISH_GRACE_MS) {
          return yield* invalid("The game isn't over yet");
        }
        if (now > lobby.endsAt.getTime() + FINISH_GRACE_MS) {
          return yield* invalid("The game is over");
        }
        const result = scoreReflex(reflex, payload.taps);
        if (!result.ok) return yield* invalid(result.reason);

        // Guarded like a race finish: once, and only for the round this
        // game was scored against.
        const recorded = yield* dbQuery(() =>
          db
            .update(gameLobbyPlayers)
            .set({
              durationMs: now - startsAt,
              score: result.score,
              accuracy: result.accuracy,
              detail: { rounds: result.rounds },
            })
            .where(
              and(
                eq(gameLobbyPlayers.lobbyId, id),
                eq(gameLobbyPlayers.userId, currentUser.id),
                isNull(gameLobbyPlayers.durationMs),
                sql`exists (select 1 from ${gameLobbies} where ${gameLobbies.id} = ${id} and ${gameLobbies.round} = ${lobby.round})`,
              ),
            )
            .returning({ id: gameLobbyPlayers.id }),
        );
        if (recorded.length === 0) {
          return yield* invalid("You already finished");
        }
        yield* touchLobby(db, id);
        yield* notifyLobbyChanged(connections, lobby);
        return yield* buildLobby({ db, connections }, id, currentUser.id);
      }),
  }) satisfies GamesHandlers;
