import { HttpApiBuilder } from "@effect/platform";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { Context, Effect } from "effect";
import {
  ChatApi,
  Forbidden,
  InvalidGameRequest,
  LEADERBOARD_SIZE,
  MAX_GAME_LOBBY_PLAYERS,
  NotFound,
  type GameId,
  type GameLobby,
  type GameLobbyPhase,
  type LeaderboardEntry,
  type LeaderboardPeriod,
} from "./Api.ts";
import { CurrentUser } from "./Auth.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import {
  gameLobbies,
  gameLobbyPlayers,
  gameResults,
  users,
  type DbGameLobby,
} from "./db/schema.ts";
import { GAME_RULES } from "./games/rules.ts";
import { gameHubRoom, gameLobbyRoom, RealtimeConnections } from "./Realtime.ts";
import { publicUserColumns, toPublicUser } from "./UsersHandler.ts";

// A lobby nobody has touched (joined, left, started, finished, rematched)
// for this long is presumed abandoned — a closed tab never says goodbye — and
// is left out of the lobby browser and quick play.
const STALE_LOBBY_MS = 15 * 60_000;
// Long past stale: creating a lobby sweeps these away entirely, so abandoned
// rows don't accumulate without needing a background job.
const DEAD_LOBBY_MS = 6 * 60 * 60_000;
// A finish that left the client just before `endsAt` can land a moment
// after it; this much network slack is still credited.
const FINISH_GRACE_MS = 2_000;
// The lobby browser shows at most this many lobbies.
const MAX_LISTED_LOBBIES = 30;

const DAY_MS = 24 * 60 * 60_000;
const PERIOD_MS: Record<LeaderboardPeriod, number | null> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  all: null,
};

const round1 = (value: number) => Math.round(value * 10) / 10;

type PlayerRow = {
  readonly lobbyId: number;
  readonly joinedAt: Date;
  readonly durationMs: number | null;
  readonly score: number | null;
  readonly accuracy: number | null;
  readonly place: number | null;
  readonly user: Parameters<typeof toPublicUser>[0];
};

// See GameLobbyPhase in Api.ts. Derived from the clock rather than written by
// a timer, so every replica agrees without any one of them owning the lobby.
export const lobbyPhase = (
  lobby: Pick<DbGameLobby, "status" | "startsAt" | "endsAt">,
  players: ReadonlyArray<{ readonly durationMs: number | null }>,
  now: number,
): GameLobbyPhase => {
  if (lobby.status === "waiting" || !lobby.startsAt || !lobby.endsAt) {
    return "waiting";
  }
  if (now < lobby.startsAt.getTime()) return "countdown";
  if (now >= lobby.endsAt.getTime()) return "finished";
  if (players.length > 0 && players.every((p) => p.durationMs !== null)) {
    return "finished";
  }
  return "racing";
};

const loadLobby = (db: DrizzleDb, id: number) =>
  Effect.tryPromise(() =>
    db.select().from(gameLobbies).where(eq(gameLobbies.id, id)).limit(1),
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0] ?? null),
  );

const loadLobbyOr404 = (db: DrizzleDb, id: number) =>
  loadLobby(db, id).pipe(
    Effect.flatMap((lobby) =>
      lobby
        ? Effect.succeed(lobby)
        : Effect.fail(new NotFound({ message: "Lobby not found" })),
    ),
  );

// Seated players for each of `lobbyIds`, in join order, with the public user
// columns joined in for rendering.
const loadPlayers = (db: DrizzleDb, lobbyIds: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const byLobby = new Map<number, PlayerRow[]>();
    if (lobbyIds.length === 0) return byLobby;
    const rows = yield* Effect.tryPromise(() =>
      db
        .select({
          lobbyId: gameLobbyPlayers.lobbyId,
          joinedAt: gameLobbyPlayers.joinedAt,
          durationMs: gameLobbyPlayers.durationMs,
          score: gameLobbyPlayers.score,
          accuracy: gameLobbyPlayers.accuracy,
          place: gameLobbyPlayers.place,
          user: publicUserColumns,
        })
        .from(gameLobbyPlayers)
        .innerJoin(users, eq(users.id, gameLobbyPlayers.userId))
        .where(inArray(gameLobbyPlayers.lobbyId, [...lobbyIds]))
        .orderBy(asc(gameLobbyPlayers.joinedAt), asc(gameLobbyPlayers.id)),
    ).pipe(Effect.orDie);
    for (const row of rows) {
      const list = byLobby.get(row.lobbyId) ?? [];
      list.push(row);
      byLobby.set(row.lobbyId, list);
    }
    return byLobby;
  });

const toApiLobby = (
  lobby: DbGameLobby,
  players: ReadonlyArray<PlayerRow>,
  now: number,
  { revealPassage }: { readonly revealPassage: boolean },
): GameLobby => {
  const phase = lobbyPhase(lobby, players, now);
  return {
    id: lobby.id,
    game: lobby.game as GameId,
    hostId: lobby.hostId,
    phase,
    round: lobby.round,
    passage: revealPassage && phase !== "waiting" ? lobby.passage : null,
    startsAt: phase === "waiting" ? null : (lobby.startsAt?.getTime() ?? null),
    endsAt: phase === "waiting" ? null : (lobby.endsAt?.getTime() ?? null),
    serverNow: now,
    maxPlayers: lobby.maxPlayers,
    players: players.map((player) => ({
      user: toPublicUser(player.user),
      joinedAt: player.joinedAt.getTime(),
      durationMs: player.durationMs,
      score: player.score,
      accuracy: player.accuracy,
      place: player.place,
    })),
    createdAt: lobby.createdAt.getTime(),
  };
};

// The full lobby as its own page renders it — passage included once a race
// is underway.
const buildLobby = (db: DrizzleDb, id: number) =>
  Effect.gen(function* () {
    const lobby = yield* loadLobbyOr404(db, id);
    const players = yield* loadPlayers(db, [id]);
    return toApiLobby(lobby, players.get(id) ?? [], Date.now(), {
      revealPassage: true,
    });
  });

// Everyone looking at this lobby refetches it; everyone looking at the
// game's lobby browser refetches the list.
const notifyLobbyChanged = (
  connections: Context.Tag.Service<typeof RealtimeConnections>,
  lobby: Pick<DbGameLobby, "id" | "game">,
) =>
  Effect.all(
    [
      connections.notifyRoom(gameLobbyRoom(lobby.id), {
        type: "game_lobby_updated",
        lobbyId: lobby.id,
      }),
      connections.notifyRoom(gameHubRoom(lobby.game), {
        type: "game_lobbies_changed",
        game: lobby.game,
      }),
    ],
    { discard: true },
  );

const touchLobby = (db: DrizzleDb, id: number, extra: object = {}) =>
  Effect.tryPromise(() =>
    db
      .update(gameLobbies)
      .set({ updatedAt: new Date(), ...extra })
      .where(eq(gameLobbies.id, id)),
  ).pipe(Effect.orDie);

// Unseats `userId` from `lobbyId`: the last player out closes the lobby, and
// a departing host hands it to whoever has been seated longest.
const leaveLobby = (
  db: DrizzleDb,
  connections: Context.Tag.Service<typeof RealtimeConnections>,
  lobbyId: number,
  userId: number,
) =>
  Effect.gen(function* () {
    const removed = yield* Effect.tryPromise(() =>
      db
        .delete(gameLobbyPlayers)
        .where(
          and(
            eq(gameLobbyPlayers.lobbyId, lobbyId),
            eq(gameLobbyPlayers.userId, userId),
          ),
        )
        .returning({ id: gameLobbyPlayers.id }),
    ).pipe(Effect.orDie);
    if (removed.length === 0) return;

    const lobby = yield* loadLobby(db, lobbyId);
    if (!lobby) return;
    const remaining = yield* Effect.tryPromise(() =>
      db
        .select({ userId: gameLobbyPlayers.userId })
        .from(gameLobbyPlayers)
        .where(eq(gameLobbyPlayers.lobbyId, lobbyId))
        .orderBy(asc(gameLobbyPlayers.joinedAt), asc(gameLobbyPlayers.id)),
    ).pipe(Effect.orDie);

    if (remaining.length === 0) {
      yield* Effect.tryPromise(() =>
        db.delete(gameLobbies).where(eq(gameLobbies.id, lobbyId)),
      ).pipe(Effect.orDie);
    } else if (lobby.hostId === userId) {
      yield* touchLobby(db, lobbyId, { hostId: remaining[0]!.userId });
    } else {
      yield* touchLobby(db, lobbyId);
    }
    yield* notifyLobbyChanged(connections, lobby);
  });

// One lobby at a time: sitting down somewhere new stands you up everywhere
// else, so a forgotten tab can't leave a ghost seat behind.
const leaveOtherLobbies = (
  db: DrizzleDb,
  connections: Context.Tag.Service<typeof RealtimeConnections>,
  userId: number,
  keepLobbyId: number | null,
) =>
  Effect.gen(function* () {
    const seats = yield* Effect.tryPromise(() =>
      db
        .select({ lobbyId: gameLobbyPlayers.lobbyId })
        .from(gameLobbyPlayers)
        .where(
          keepLobbyId === null
            ? eq(gameLobbyPlayers.userId, userId)
            : and(
                eq(gameLobbyPlayers.userId, userId),
                ne(gameLobbyPlayers.lobbyId, keepLobbyId),
              ),
        ),
    ).pipe(Effect.orDie);
    yield* Effect.forEach(
      seats,
      (seat) => leaveLobby(db, connections, seat.lobbyId, userId),
      { discard: true },
    );
  });

const joinLobby = (
  db: DrizzleDb,
  connections: Context.Tag.Service<typeof RealtimeConnections>,
  lobbyId: number,
  userId: number,
) =>
  Effect.gen(function* () {
    const lobby = yield* loadLobbyOr404(db, lobbyId);
    const players = (yield* loadPlayers(db, [lobbyId])).get(lobbyId) ?? [];
    if (players.some((player) => player.user.id === userId)) {
      return yield* buildLobby(db, lobbyId);
    }
    if (lobbyPhase(lobby, players, Date.now()) !== "waiting") {
      return yield* Effect.fail(
        new InvalidGameRequest({ message: "This race has already started" }),
      );
    }
    if (players.length >= lobby.maxPlayers) {
      return yield* Effect.fail(
        new InvalidGameRequest({ message: "This lobby is full" }),
      );
    }
    yield* leaveOtherLobbies(db, connections, userId, lobbyId);
    yield* Effect.tryPromise(() =>
      db
        .insert(gameLobbyPlayers)
        .values({ lobbyId, userId })
        .onConflictDoNothing(),
    ).pipe(Effect.orDie);
    yield* touchLobby(db, lobbyId);
    yield* notifyLobbyChanged(connections, lobby);
    return yield* buildLobby(db, lobbyId);
  });

const createLobby = (
  db: DrizzleDb,
  connections: Context.Tag.Service<typeof RealtimeConnections>,
  game: GameId,
  userId: number,
) =>
  Effect.gen(function* () {
    yield* leaveOtherLobbies(db, connections, userId, null);
    // Opportunistic cleanup of long-abandoned lobbies (their seats cascade).
    yield* Effect.tryPromise(() =>
      db
        .delete(gameLobbies)
        .where(lt(gameLobbies.updatedAt, new Date(Date.now() - DEAD_LOBBY_MS))),
    ).pipe(Effect.orDie);
    const [lobby] = yield* Effect.tryPromise(() =>
      db
        .insert(gameLobbies)
        .values({ game, hostId: userId, maxPlayers: MAX_GAME_LOBBY_PLAYERS })
        .returning(),
    ).pipe(Effect.orDie);
    yield* Effect.tryPromise(() =>
      db.insert(gameLobbyPlayers).values({ lobbyId: lobby!.id, userId }),
    ).pipe(Effect.orDie);
    yield* notifyLobbyChanged(connections, lobby!);
    return yield* buildLobby(db, lobby!.id);
  });

// createLobby/quickPlay read back a lobby they've only just created or
// joined, so a NotFound there is a defect (it was deleted in between), not a
// client error those endpoints document.
const dieOnVanishedLobby = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf((e) => e instanceof NotFound, Effect.die),
  ) as Effect.Effect<A, Exclude<E, NotFound>, R>;

const requireHost = (lobby: DbGameLobby, userId: number, action: string) =>
  lobby.hostId === userId
    ? Effect.void
    : Effect.fail(
        new Forbidden({ message: `Only the lobby host can ${action}` }),
      );

const leaderboardEntry = (row: {
  rank: number;
  bestScore: number;
  averageScore: number;
  averageAccuracy: number;
  races: number;
  wins: number;
  user: Parameters<typeof toPublicUser>[0];
}): LeaderboardEntry => ({
  rank: row.rank,
  user: toPublicUser(row.user),
  bestScore: round1(row.bestScore),
  averageScore: round1(row.averageScore),
  averageAccuracy: round1(row.averageAccuracy),
  races: row.races,
  wins: row.wins,
});

export const GamesHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "games",
  (handlers) =>
    handlers
      .handle("listGameLobbies", ({ path: { game } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const now = Date.now();
          const lobbies = yield* Effect.tryPromise(() =>
            db
              .select()
              .from(gameLobbies)
              .where(
                and(
                  eq(gameLobbies.game, game),
                  gt(gameLobbies.updatedAt, new Date(now - STALE_LOBBY_MS)),
                ),
              )
              .orderBy(desc(gameLobbies.updatedAt), desc(gameLobbies.id))
              .limit(MAX_LISTED_LOBBIES),
          ).pipe(Effect.orDie);
          const players = yield* loadPlayers(
            db,
            lobbies.map((lobby) => lobby.id),
          );
          return {
            lobbies: lobbies
              .map((lobby) =>
                toApiLobby(lobby, players.get(lobby.id) ?? [], now, {
                  revealPassage: false,
                }),
              )
              // A finished race is only interesting to the people in it,
              // until the host rematches it back to "waiting".
              .filter((lobby) => lobby.phase !== "finished"),
          };
        }),
      )
      .handle("createGameLobby", ({ path: { game } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          return yield* createLobby(db, connections, game, currentUser.id);
        }).pipe(dieOnVanishedLobby),
      )
      .handle("quickPlay", ({ path: { game } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const now = Date.now();
          const open = yield* Effect.tryPromise(() =>
            db
              .select()
              .from(gameLobbies)
              .where(
                and(
                  eq(gameLobbies.game, game),
                  eq(gameLobbies.status, "waiting"),
                  gt(gameLobbies.updatedAt, new Date(now - STALE_LOBBY_MS)),
                ),
              )
              .orderBy(desc(gameLobbies.updatedAt)),
          ).pipe(Effect.orDie);
          const players = yield* loadPlayers(
            db,
            open.map((lobby) => lobby.id),
          );
          // Already waiting somewhere? Stay put rather than hop lobbies.
          const seated = open.find((lobby) =>
            (players.get(lobby.id) ?? []).some(
              (player) => player.user.id === currentUser.id,
            ),
          );
          if (seated) return yield* buildLobby(db, seated.id);
          // Fullest lobby with room first — gets a race going soonest.
          const candidate = open
            .filter(
              (lobby) =>
                (players.get(lobby.id)?.length ?? 0) < lobby.maxPlayers,
            )
            .sort(
              (a, b) =>
                (players.get(b.id)?.length ?? 0) -
                (players.get(a.id)?.length ?? 0),
            )[0];
          if (candidate) {
            const joined = yield* joinLobby(
              db,
              connections,
              candidate.id,
              currentUser.id,
            ).pipe(Effect.option);
            if (joined._tag === "Some") return joined.value;
          }
          return yield* createLobby(db, connections, game, currentUser.id);
        }).pipe(dieOnVanishedLobby),
      )
      .handle("getGameLobby", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          return yield* buildLobby(db, id);
        }),
      )
      .handle("joinGameLobby", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          return yield* joinLobby(db, connections, id, currentUser.id);
        }),
      )
      .handle("leaveGameLobby", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          yield* loadLobbyOr404(db, id);
          yield* leaveLobby(db, connections, id, currentUser.id);
        }),
      )
      .handle("startGameLobby", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const lobby = yield* loadLobbyOr404(db, id);
          yield* requireHost(lobby, currentUser.id, "start the race");
          const rules = GAME_RULES[lobby.game as GameId];
          const startsAt = new Date(Date.now() + rules.countdownMs);
          // Conditional on still "waiting", so a double-click (or two tabs)
          // can't restart a race that's already counting down.
          const started = yield* Effect.tryPromise(() =>
            db
              .update(gameLobbies)
              .set({
                status: "started",
                passage: rules.pickPassage(lobby.passage),
                startsAt,
                endsAt: new Date(startsAt.getTime() + rules.timeLimitMs),
                updatedAt: new Date(),
              })
              .where(
                and(eq(gameLobbies.id, id), eq(gameLobbies.status, "waiting")),
              )
              .returning({ id: gameLobbies.id }),
          ).pipe(Effect.orDie);
          if (started.length === 0) {
            return yield* Effect.fail(
              new InvalidGameRequest({ message: "The race already started" }),
            );
          }
          yield* notifyLobbyChanged(connections, lobby);
          return yield* buildLobby(db, id);
        }),
      )
      .handle("finishRace", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const now = Date.now();
          const lobby = yield* loadLobbyOr404(db, id);
          const players = (yield* loadPlayers(db, [id])).get(id) ?? [];
          const me = players.find(
            (player) => player.user.id === currentUser.id,
          );
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
          const result = GAME_RULES[lobby.game as GameId].score({
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
          const recorded = yield* Effect.tryPromise(() =>
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
          ).pipe(Effect.orDie);
          if (recorded.length === 0) {
            return yield* Effect.fail(
              new InvalidGameRequest({ message: "You already finished" }),
            );
          }

          // Finish time is the server's clock at acceptance, so it only ever
          // grows with arrival order and "how many finished faster" is the
          // place. Two finishes landing in the very same instant can share
          // a place — a tie is the honest outcome there anyway.
          const [faster] = yield* Effect.tryPromise(() =>
            db
              .select({ count: sql<number>`cast(count(*) as int)` })
              .from(gameLobbyPlayers)
              .where(
                and(
                  eq(gameLobbyPlayers.lobbyId, id),
                  lt(gameLobbyPlayers.durationMs, durationMs),
                ),
              ),
          ).pipe(Effect.orDie);
          const place = (faster?.count ?? 0) + 1;
          yield* Effect.tryPromise(() =>
            db
              .update(gameLobbyPlayers)
              .set({ place })
              .where(eq(gameLobbyPlayers.id, recorded[0]!.id)),
          ).pipe(Effect.orDie);
          yield* Effect.tryPromise(() =>
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
          ).pipe(Effect.orDie);
          yield* touchLobby(db, id);
          yield* notifyLobbyChanged(connections, lobby);
          return yield* buildLobby(db, id);
        }),
      )
      .handle("rematchGameLobby", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const lobby = yield* loadLobbyOr404(db, id);
          yield* requireHost(lobby, currentUser.id, "start a rematch");
          const players = (yield* loadPlayers(db, [id])).get(id) ?? [];
          if (lobbyPhase(lobby, players, Date.now()) !== "finished") {
            return yield* Effect.fail(
              new InvalidGameRequest({
                message: "The current race hasn't finished yet",
              }),
            );
          }
          // `passage` is kept (hidden while waiting — see toApiLobby) so the
          // next start can avoid repeating it.
          const reset = yield* Effect.tryPromise(() =>
            db
              .update(gameLobbies)
              .set({
                status: "waiting",
                round: lobby.round + 1,
                startsAt: null,
                endsAt: null,
                updatedAt: new Date(),
              })
              .where(
                and(eq(gameLobbies.id, id), eq(gameLobbies.round, lobby.round)),
              )
              .returning({ id: gameLobbies.id }),
          ).pipe(Effect.orDie);
          if (reset.length > 0) {
            yield* Effect.tryPromise(() =>
              db
                .update(gameLobbyPlayers)
                .set({
                  durationMs: null,
                  score: null,
                  accuracy: null,
                  place: null,
                })
                .where(eq(gameLobbyPlayers.lobbyId, id)),
            ).pipe(Effect.orDie);
            yield* notifyLobbyChanged(connections, lobby);
          }
          return yield* buildLobby(db, id);
        }),
      )
      .handle("getLeaderboard", ({ path: { game }, urlParams }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const period = urlParams.period ?? "all";
          const windowMs = PERIOD_MS[period];

          // Per-player aggregates, ranked by best score, in one pass. `rank()`
          // (not `row_number()`) so equal bests share a rank.
          const stats = db.$with("stats").as(
            db
              .select({
                userId: gameResults.userId,
                bestScore: sql<number>`max(${gameResults.score})`.as(
                  "best_score",
                ),
                averageScore: sql<number>`avg(${gameResults.score})`.as(
                  "average_score",
                ),
                averageAccuracy: sql<number>`avg(${gameResults.accuracy})`.as(
                  "average_accuracy",
                ),
                races: sql<number>`cast(count(*) as int)`.as("races"),
                wins: sql<number>`cast(count(*) filter (where ${gameResults.place} = 1 and ${gameResults.playerCount} > 1) as int)`.as(
                  "wins",
                ),
                rank: sql<number>`cast(rank() over (order by max(${gameResults.score}) desc) as int)`.as(
                  "rank",
                ),
              })
              .from(gameResults)
              .where(
                windowMs === null
                  ? eq(gameResults.game, game)
                  : and(
                      eq(gameResults.game, game),
                      gte(
                        gameResults.createdAt,
                        new Date(Date.now() - windowMs),
                      ),
                    ),
              )
              .groupBy(gameResults.userId),
          );
          const rows = yield* Effect.tryPromise(() =>
            db
              .with(stats)
              .select({
                rank: stats.rank,
                bestScore: stats.bestScore,
                averageScore: stats.averageScore,
                averageAccuracy: stats.averageAccuracy,
                races: stats.races,
                wins: stats.wins,
                user: publicUserColumns,
              })
              .from(stats)
              .innerJoin(users, eq(users.id, stats.userId))
              .where(
                or(
                  sql`${stats.rank} <= ${LEADERBOARD_SIZE}`,
                  eq(stats.userId, currentUser.id),
                ),
              )
              .orderBy(asc(stats.rank), asc(stats.userId)),
          ).pipe(Effect.orDie);

          const entries = rows.map(leaderboardEntry);
          return {
            game,
            period,
            // Ties at the cutoff can rank more than LEADERBOARD_SIZE players
            // inside it; the slice keeps the table a fixed size.
            entries: entries
              .filter((entry) => entry.rank <= LEADERBOARD_SIZE)
              .slice(0, LEADERBOARD_SIZE),
            me:
              entries.find((entry) => entry.user.id === currentUser.id) ?? null,
          };
        }),
      ),
);
