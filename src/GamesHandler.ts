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
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { Context, Effect, Metric, MetricLabel } from "effect";
import {
  ChatApi,
  DRAWING_HEIGHT,
  GAME_CHAT_PAGE_SIZE,
  Forbidden,
  InvalidGameRequest,
  LEADERBOARD_SIZE,
  MAX_DRAWING_POINTS,
  NotFound,
  TooManyRequests,
  type DrawingStroke,
  type GameChatMessage,
  type GameId,
  type GameLobby,
  type GameLobbyPhase,
  type LeaderboardEntry,
  type LeaderboardPeriod,
} from "./Api.ts";
import { CurrentUser } from "./Auth.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import {
  gameBluffs,
  gameDrawings,
  gameLobbies,
  gameLobbyMessages,
  gameLobbyPlayers,
  gameResults,
  gameVotes,
  notifications,
  users,
  type DbGameLobby,
  type DrawingLobbySettings,
} from "./db/schema.ts";
import { buildBallot } from "./games/drawing/ballot.ts";
import {
  bluffsFor,
  EMPTY_GAME_ROWS,
  participantsOf,
  type DrawingGameRows,
} from "./games/drawing/model.ts";
import {
  DRAWING_PACKS,
  findDrawingPack,
  promptPool,
} from "./games/drawing/packs/index.ts";
import {
  dealPrompts,
  isTooCloseToPrompt,
  normalizeTitle,
  secureRandomInt,
  shuffled,
} from "./games/drawing/prompts.ts";
import {
  DEFAULT_DRAWING_SETTINGS,
  DRAWING_SUBMIT_GRACE_MS,
} from "./games/drawing/rules.ts";
import {
  guessAccuracy,
  placeOf,
  tallyScores,
} from "./games/drawing/scoring.ts";
import { loadDrawingRows } from "./games/drawing/store.ts";
import {
  buildTimeline,
  currentStage,
  drawingPhase,
  worstCaseDurationMs,
  type TimelineStage,
} from "./games/drawing/timeline.ts";
import {
  drawingSettingsOnly,
  projectDrawingGame,
} from "./games/drawing/view.ts";
import { GAME_RULES, type RaceRules } from "./games/rules.ts";
import { rateLimitRejectionsTotal } from "./Metrics.ts";
import { blockedOrMutedUserIds } from "./blocks.ts";
import { createNotifications } from "./notifications.ts";
import { RateLimiter } from "./RateLimiter.ts";
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

// Everything a response about one lobby is built from, read once so every
// part of it agrees on the same instant: the lobby row, its seated players,
// and — for a started Sketchy game — the game's rows and the timeline
// derived from them.
type LobbySnapshot = {
  readonly lobby: DbGameLobby;
  readonly players: ReadonlyArray<PlayerRow>;
  readonly drawing: {
    readonly settings: DrawingLobbySettings;
    readonly rows: DrawingGameRows;
    // Empty until the game starts.
    readonly timeline: ReadonlyArray<TimelineStage>;
  } | null;
  readonly phase: GameLobbyPhase;
  readonly now: number;
};

const settingsOf = (lobby: DbGameLobby): DrawingLobbySettings =>
  lobby.settings ?? DEFAULT_DRAWING_SETTINGS;

const snapshotOf = (
  lobby: DbGameLobby,
  players: ReadonlyArray<PlayerRow>,
  rows: DrawingGameRows,
  now: number,
): LobbySnapshot => {
  if (GAME_RULES[lobby.game as GameId].kind !== "drawing") {
    return {
      lobby,
      players,
      drawing: null,
      phase: lobbyPhase(lobby, players, now),
      now,
    };
  }
  const started = lobby.status === "started" && lobby.startsAt !== null;
  const timeline = started
    ? buildTimeline(lobby.startsAt!.getTime(), rows)
    : [];
  return {
    lobby,
    players,
    drawing: { settings: settingsOf(lobby), rows, timeline },
    phase: started
      ? drawingPhase(lobby.startsAt!.getTime(), timeline, now)
      : "waiting",
    now,
  };
};

// Snapshots of several lobbies at once — players and Sketchy rows in a
// fixed number of queries, however many lobbies (the lobby browser).
const loadSnapshots = (db: DrizzleDb, lobbies: ReadonlyArray<DbGameLobby>) =>
  Effect.gen(function* () {
    const players = yield* loadPlayers(
      db,
      lobbies.map((lobby) => lobby.id),
    );
    const rows = yield* loadDrawingRows(
      db,
      lobbies
        .filter(
          (lobby) =>
            GAME_RULES[lobby.game as GameId].kind === "drawing" &&
            lobby.status === "started",
        )
        .map((lobby) => lobby.id),
    );
    const now = Date.now();
    return lobbies.map((lobby) =>
      snapshotOf(
        lobby,
        players.get(lobby.id) ?? [],
        rows.get(lobby.id) ?? EMPTY_GAME_ROWS,
        now,
      ),
    );
  });

const loadSnapshot = (db: DrizzleDb, id: number) =>
  loadLobbyOr404(db, id).pipe(
    Effect.flatMap((lobby) => loadSnapshots(db, [lobby])),
    Effect.map(([snapshot]) => snapshot!),
  );

// A finished Sketchy game's final standings — every drawing counted.
const finalTallies = (snapshot: LobbySnapshot) => {
  const { rows } = snapshot.drawing!;
  return tallyScores(
    participantsOf(rows),
    rows.drawings,
    rows.bluffs,
    rows.votes,
    () => true,
  );
};

// Whether `snapshot`'s lobby chat takes messages right now — see
// `chatDuringPlay` in src/games/rules.ts.
const chatOpenFor = (snapshot: Pick<LobbySnapshot, "lobby" | "phase">) =>
  GAME_RULES[snapshot.lobby.game as GameId].chatDuringPlay ||
  snapshot.phase === "waiting" ||
  snapshot.phase === "finished";

// `viewerId` null builds the lobby browser's view: no passage, and only the
// settings of a Sketchy game.
const toApiLobby = (
  snapshot: LobbySnapshot,
  viewerId: number | null,
): GameLobby => {
  const { lobby, players, drawing, phase, now } = snapshot;
  const rules = GAME_RULES[lobby.game as GameId];
  const timelineEnd = drawing?.timeline.at(-1)?.endsAt;
  // Sketchy scores a whole game at once, so its results are derived from
  // the votes when it's over rather than stored per player like a finish.
  const tallies =
    drawing && phase === "finished" ? finalTallies(snapshot) : null;
  const gameLength =
    lobby.startsAt && timelineEnd !== undefined
      ? timelineEnd - lobby.startsAt.getTime()
      : null;

  return {
    id: lobby.id,
    game: lobby.game as GameId,
    hostId: lobby.hostId,
    phase,
    round: lobby.round,
    passage:
      viewerId !== null && !drawing && phase !== "waiting"
        ? lobby.passage
        : null,
    startsAt: phase === "waiting" ? null : (lobby.startsAt?.getTime() ?? null),
    endsAt:
      phase === "waiting"
        ? null
        : (timelineEnd ?? lobby.endsAt?.getTime() ?? null),
    serverNow: now,
    minPlayers: rules.minPlayers,
    maxPlayers: lobby.maxPlayers,
    players: players.map((player) => {
      const tally = tallies?.find((t) => t.userId === player.user.id);
      return {
        user: toPublicUser(player.user),
        joinedAt: player.joinedAt.getTime(),
        ...(tallies
          ? {
              durationMs: tally ? gameLength : null,
              score: tally?.score ?? null,
              accuracy: tally ? guessAccuracy(tally) : null,
              place: tally ? placeOf(tallies, tally.score) : null,
            }
          : {
              durationMs: player.durationMs,
              score: player.score,
              accuracy: player.accuracy,
              place: player.place,
            }),
      };
    }),
    drawing: !drawing
      ? null
      : viewerId === null || phase === "waiting"
        ? drawingSettingsOnly(drawing.settings)
        : projectDrawingGame({
            settings: drawing.settings,
            rows: drawing.rows,
            timeline: drawing.timeline,
            now,
            finished: phase === "finished",
            viewerId,
          }),
    chatOpen: chatOpenFor(snapshot),
    createdAt: lobby.createdAt.getTime(),
  };
};

// The full lobby as its own page renders it for `viewerId` — passage
// included once a race is underway, a Sketchy game filtered down to what
// the viewer may see. The first read to find a Sketchy game over also
// settles its results (see `settleDrawingGame`).
const buildLobby = (db: DrizzleDb, id: number, viewerId: number) =>
  Effect.gen(function* () {
    const snapshot = yield* loadSnapshot(db, id);
    yield* settleIfOver(db, snapshot);
    return toApiLobby(snapshot, viewerId);
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
      return yield* buildLobby(db, lobbyId, userId);
    }
    if (lobby.status !== "waiting") {
      return yield* Effect.fail(
        new InvalidGameRequest({ message: "This game has already started" }),
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
    return yield* buildLobby(db, lobbyId, userId);
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
    const rules = GAME_RULES[game];
    const [lobby] = yield* Effect.tryPromise(() =>
      db
        .insert(gameLobbies)
        .values({
          game,
          hostId: userId,
          maxPlayers: rules.maxPlayers,
          settings: rules.kind === "drawing" ? DEFAULT_DRAWING_SETTINGS : null,
        })
        .returning(),
    ).pipe(Effect.orDie);
    yield* Effect.tryPromise(() =>
      db.insert(gameLobbyPlayers).values({ lobbyId: lobby!.id, userId }),
    ).pipe(Effect.orDie);
    yield* notifyLobbyChanged(connections, lobby!);
    return yield* buildLobby(db, lobby!.id, userId);
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

const invalid = (message: string) =>
  Effect.fail(new InvalidGameRequest({ message }));

// The race-only rules of `lobby`'s game, or a 400 for any other game.
const requireRace = (lobby: DbGameLobby) => {
  const rules = GAME_RULES[lobby.game as GameId];
  return rules.kind === "race"
    ? Effect.succeed<RaceRules>(rules)
    : invalid("This game has no races to finish");
};

// A started Sketchy game's state, or a 400 for anything else — the common
// preamble of every Sketchy submission.
const requireDrawingGame = (snapshot: LobbySnapshot) =>
  snapshot.drawing && snapshot.lobby.status === "started"
    ? Effect.succeed(snapshot.drawing)
    : invalid(
        snapshot.drawing
          ? "The game hasn't started yet"
          : "This isn't a Sketchy lobby",
      );

// A caller dealt into this Sketchy game — seated at the start, whether or
// not they're still here (a player who left can't act, since they can't
// see the lobby's page to).
const requireParticipant = (rows: DrawingGameRows, userId: number) =>
  participantsOf(rows).includes(userId)
    ? Effect.void
    : Effect.fail(
        new Forbidden({ message: "You're not playing in this game" }),
      );

// A drawing's strokes as the schema can't check them on its own: points
// come in (x, y) pairs, y stays on the canvas, and the whole drawing keeps
// to the point budget.
const validateStrokes = (strokes: ReadonlyArray<DrawingStroke>) => {
  let total = 0;
  for (const stroke of strokes) {
    if (stroke.points.length % 2 !== 0) {
      return invalid("Every stroke point needs an x and a y");
    }
    for (let i = 1; i < stroke.points.length; i += 2) {
      if (stroke.points[i]! > DRAWING_HEIGHT) {
        return invalid("A stroke goes off the canvas");
      }
    }
    total += stroke.points.length / 2;
  }
  return total > MAX_DRAWING_POINTS
    ? invalid("That drawing has too many points")
    : Effect.void;
};

// Each invite drops a notification into someone else's inbox, so it gets the
// same kind of per-user cap as the engagement writes (see
// EngagementHandler.ts) — generous for a human filling a lobby, but a bound
// on scripting invites at the whole user directory.
const GAME_INVITE_MAX_PER_USER = 30;
const GAME_INVITE_WINDOW_SECONDS = 60;

const enforceInviteLimit = (userId: number) =>
  Effect.gen(function* () {
    const limiter = yield* RateLimiter;
    const result = yield* limiter.consume(
      `games:invite:user:${userId}`,
      GAME_INVITE_MAX_PER_USER,
      GAME_INVITE_WINDOW_SECONDS,
    );
    if (!result.allowed) {
      yield* Metric.update(
        Metric.taggedWithLabels(rateLimitRejectionsTotal, [
          MetricLabel.make("limiter", "game_invite"),
        ]),
        1,
      );
      return yield* Effect.fail(
        new TooManyRequests({
          message: "Too many invites. Please try again later.",
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
    }
  });

// A lobby's chat fans every line out to the whole room, so a per-user cap
// keeps one flooder from drowning it — roomy for a lively conversation.
const GAME_CHAT_MAX_PER_USER = 10;
const GAME_CHAT_WINDOW_SECONDS = 15;

const enforceChatLimit = (userId: number) =>
  Effect.gen(function* () {
    const limiter = yield* RateLimiter;
    const result = yield* limiter.consume(
      `games:chat:user:${userId}`,
      GAME_CHAT_MAX_PER_USER,
      GAME_CHAT_WINDOW_SECONDS,
    );
    if (!result.allowed) {
      yield* Metric.update(
        Metric.taggedWithLabels(rateLimitRejectionsTotal, [
          MetricLabel.make("limiter", "game_chat"),
        ]),
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

// The player holding `game`'s all-time best score right now (earliest to
// reach it on a tie), or null before anyone has finished a race.
const currentRecordHolder = (db: DrizzleDb, game: string) =>
  Effect.tryPromise(() =>
    db
      .select({ userId: gameResults.userId, score: gameResults.score })
      .from(gameResults)
      .where(eq(gameResults.game, game))
      .orderBy(desc(gameResults.score), asc(gameResults.id))
      .limit(1),
  ).pipe(
    Effect.orDie,
    Effect.map((rows) => rows[0] ?? null),
  );

// Tells the holder of `game`'s all-time best (as it stood before `results`
// were recorded) that they've lost it, if one of `results` took it from
// them — the one leaderboard change worth a notification, since it's the
// one they'd want to win back. Improving your own record is silent.
const notifyRecordBroken = (
  game: string,
  lobbyId: number,
  previous: { readonly userId: number; readonly score: number } | null,
  results: ReadonlyArray<{ readonly userId: number; readonly score: number }>,
) =>
  Effect.gen(function* () {
    if (!previous) return;
    const best = [...results].sort((a, b) => b.score - a.score)[0];
    if (!best || best.userId === previous.userId) return;
    if (best.score <= previous.score) return;
    yield* createNotifications([
      {
        userId: previous.userId,
        actorId: best.userId,
        type: "game_record",
        game,
        lobbyId,
      },
    ]);
  });

// Records a finished Sketchy game's results — exactly once, whichever read
// gets here first on whichever replica: claiming the round in
// `settled_round` and inserting its `game_results` share one transaction,
// and the claim is conditional, so a concurrent settle finds nothing left to
// claim. Only players still seated at the end are recorded — leaving
// mid-game forfeits.
const settleIfOver = (db: DrizzleDb, snapshot: LobbySnapshot) =>
  Effect.gen(function* () {
    const { lobby, drawing, phase, players } = snapshot;
    if (!drawing || phase !== "finished" || !lobby.startsAt) return;
    if (lobby.settledRound === lobby.round) return;

    const tallies = finalTallies(snapshot);
    const seated = new Set(players.map((player) => player.user.id));
    const endsAt = drawing.timeline.at(-1)?.endsAt ?? lobby.startsAt.getTime();
    const results = tallies
      .filter((tally) => seated.has(tally.userId))
      .map((tally) => ({
        game: lobby.game,
        userId: tally.userId,
        lobbyId: lobby.id,
        round: lobby.round,
        score: tally.score,
        accuracy: guessAccuracy(tally),
        durationMs: endsAt - lobby.startsAt!.getTime(),
        place: placeOf(tallies, tally.score),
        playerCount: tallies.length,
      }));

    const record = yield* currentRecordHolder(db, lobby.game);
    const settled = yield* Effect.tryPromise(() =>
      db.transaction(async (tx) => {
        const claimed = await tx
          .update(gameLobbies)
          .set({ settledRound: lobby.round })
          .where(
            and(
              eq(gameLobbies.id, lobby.id),
              eq(gameLobbies.round, lobby.round),
              or(
                isNull(gameLobbies.settledRound),
                ne(gameLobbies.settledRound, lobby.round),
              ),
            ),
          )
          .returning({ id: gameLobbies.id });
        if (claimed.length === 0) return false;
        if (results.length > 0) await tx.insert(gameResults).values(results);
        return true;
      }),
    ).pipe(Effect.orDie);
    if (settled) {
      yield* notifyRecordBroken(lobby.game, lobby.id, record, results);
    }
  });

// The draw stage a drawing submitted `now` belongs to: the one in progress,
// or one whose timer ran out within the grace period.
const drawStageAt = (timeline: ReadonlyArray<TimelineStage>, now: number) =>
  timeline.find(
    (stage) =>
      stage.kind === "draw" &&
      stage.startedAt <= now &&
      now < stage.endsAt + DRAWING_SUBMIT_GRACE_MS,
  );

// The drawing in the spotlight, if the game is in a `kind` stage right now.
const spotlightAt = (
  drawing: NonNullable<LobbySnapshot["drawing"]>,
  kind: "bluff" | "vote",
  now: number,
) => {
  const stage = currentStage(drawing.timeline, now);
  if (stage?.kind !== kind || stage.drawingId === null) return null;
  return (
    drawing.rows.drawings.find((row) => row.id === stage.drawingId) ?? null
  );
};

// Prompts dealt recently by this process, across every lobby, newest last. A
// fresh lobby has no rematch history, so without this two games on the same
// pack would each draw from the full pool and repeat prompts often. Per
// process on purpose: it only nudges variety, it isn't correctness state.
const RECENT_DEALT_CAP = 240;
const recentlyDealt: string[] = [];

const rememberDealt = (prompts: ReadonlyArray<string>) => {
  recentlyDealt.push(...prompts);
  if (recentlyDealt.length > RECENT_DEALT_CAP)
    recentlyDealt.splice(0, recentlyDealt.length - RECENT_DEALT_CAP);
};

// Deals a Sketchy game: every seated player gets one drawing per round, each
// with a distinct prompt from the selected packs, in a shuffled order per
// round. Null when the packs can't cover the deal.
const dealDrawings = (
  lobbyId: number,
  playerIds: ReadonlyArray<number>,
  settings: DrawingLobbySettings,
) => {
  const prompts = dealPrompts(
    promptPool(settings.packs),
    playerIds.length * settings.rounds,
    [...(settings.recentPrompts ?? []), ...recentlyDealt],
  );
  if (!prompts) return null;
  rememberDealt(prompts);
  return Array.from({ length: settings.rounds }, (_, index) => index + 1)
    .flatMap((turn) =>
      shuffled(playerIds, secureRandomInt).map((artistId, position) => ({
        lobbyId,
        artistId,
        turn,
        position,
      })),
    )
    .map((drawing, index) => ({
      ...drawing,
      prompt: prompts[index]!,
      shuffleSeed: secureRandomInt(0x7fff_ffff),
    }));
};

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
          const snapshots = yield* loadSnapshots(db, lobbies);
          return {
            lobbies: snapshots
              // A finished game is only interesting to the people in it,
              // until the host rematches it back to "waiting".
              .filter((snapshot) => snapshot.phase !== "finished")
              .map((snapshot) => toApiLobby(snapshot, null)),
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
          if (seated) return yield* buildLobby(db, seated.id, currentUser.id);
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
          const currentUser = yield* CurrentUser;
          return yield* buildLobby(db, id, currentUser.id);
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
          yield* requireHost(lobby, currentUser.id, "start the game");
          const rules = GAME_RULES[lobby.game as GameId];
          const players = (yield* loadPlayers(db, [id])).get(id) ?? [];
          if (lobby.status !== "waiting") {
            return yield* invalid("The game already started");
          }
          if (players.length < rules.minPlayers) {
            return yield* invalid(
              `This game needs at least ${rules.minPlayers} players`,
            );
          }
          const startsAt = new Date(Date.now() + rules.countdownMs);

          if (rules.kind === "race") {
            // Conditional on still "waiting", so a double-click (or two
            // tabs) can't restart a race that's already counting down.
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
                  and(
                    eq(gameLobbies.id, id),
                    eq(gameLobbies.status, "waiting"),
                  ),
                )
                .returning({ id: gameLobbies.id }),
            ).pipe(Effect.orDie);
            if (started.length === 0) {
              return yield* invalid("The game already started");
            }
          } else {
            const settings = settingsOf(lobby);
            const drawings = dealDrawings(
              id,
              players.map((player) => player.user.id),
              settings,
            );
            if (!drawings) {
              return yield* invalid(
                "The selected packs don't have enough prompts for this many players",
              );
            }
            // The deal and the status flip land together: a reader must
            // never see a started game with no drawings (its timeline would
            // be empty, i.e. over before it began).
            const started = yield* Effect.tryPromise(() =>
              db.transaction(async (tx) => {
                const flipped = await tx
                  .update(gameLobbies)
                  .set({
                    status: "started",
                    startsAt,
                    endsAt: new Date(
                      startsAt.getTime() +
                        worstCaseDurationMs(players.length, settings.rounds),
                    ),
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(gameLobbies.id, id),
                      eq(gameLobbies.status, "waiting"),
                    ),
                  )
                  .returning({ id: gameLobbies.id });
                if (flipped.length === 0) return false;
                await tx.insert(gameDrawings).values(drawings);
                return true;
              }),
            ).pipe(Effect.orDie);
            if (!started) return yield* invalid("The game already started");
          }
          yield* notifyLobbyChanged(connections, lobby);
          return yield* buildLobby(db, id, currentUser.id);
        }),
      )
      .handle("finishRace", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const now = Date.now();
          const lobby = yield* loadLobbyOr404(db, id);
          const rules = yield* requireRace(lobby);
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
          const record = yield* currentRecordHolder(db, lobby.game);
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
          yield* notifyRecordBroken(lobby.game, id, record, [
            { userId: currentUser.id, score: result.score },
          ]);
          yield* touchLobby(db, id);
          yield* notifyLobbyChanged(connections, lobby);
          return yield* buildLobby(db, id, currentUser.id);
        }),
      )
      .handle("inviteToGameLobby", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const lobby = yield* loadLobbyOr404(db, id);
          const players = (yield* loadPlayers(db, [id])).get(id) ?? [];
          if (!players.some((player) => player.user.id === currentUser.id)) {
            return yield* Effect.fail(
              new Forbidden({
                message: "Only players in this lobby can invite others",
              }),
            );
          }
          if (payload.userId === currentUser.id) {
            return yield* Effect.fail(
              new InvalidGameRequest({ message: "You can't invite yourself" }),
            );
          }
          if (lobby.status !== "waiting") {
            return yield* invalid(
              "Invites can only be sent before the game starts",
            );
          }
          if (players.some((player) => player.user.id === payload.userId)) {
            return yield* Effect.fail(
              new InvalidGameRequest({
                message: "That player is already in this lobby",
              }),
            );
          }
          if (players.length >= lobby.maxPlayers) {
            return yield* Effect.fail(
              new InvalidGameRequest({ message: "This lobby is full" }),
            );
          }
          const invitee = yield* Effect.tryPromise(() =>
            db
              .select({ id: users.id })
              .from(users)
              .where(eq(users.id, payload.userId))
              .limit(1),
          ).pipe(Effect.orDie);
          if (invitee.length === 0) {
            return yield* Effect.fail(
              new NotFound({ message: "User not found" }),
            );
          }
          yield* enforceInviteLimit(currentUser.id);
          // Re-inviting someone who hasn't opened the last invite to this
          // same lobby yet is a no-op rather than a second inbox entry.
          const pending = yield* Effect.tryPromise(() =>
            db
              .select({ id: notifications.id })
              .from(notifications)
              .where(
                and(
                  eq(notifications.userId, payload.userId),
                  eq(notifications.actorId, currentUser.id),
                  eq(notifications.type, "game_invite"),
                  eq(notifications.lobbyId, id),
                  isNull(notifications.readAt),
                ),
              )
              .limit(1),
          ).pipe(Effect.orDie);
          if (pending.length > 0) return;
          // A recipient who blocked/muted the caller is silently skipped
          // inside createNotifications — the response is the same either
          // way, so an invite can't be used to probe for a block.
          yield* createNotifications([
            {
              userId: payload.userId,
              actorId: currentUser.id,
              type: "game_invite",
              game: lobby.game,
              lobbyId: id,
            },
          ]);
        }),
      )
      .handle("listGameChat", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
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
      )
      .handle("postGameChat", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const snapshot = yield* loadSnapshot(db, id);
          if (!chatOpenFor(snapshot)) {
            return yield* invalid(
              "Chat is paused while the game is in play — reactions still work!",
            );
          }
          yield* enforceChatLimit(currentUser.id);
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
      )
      .handle("rematchGameLobby", ({ path: { id } }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const snapshot = yield* loadSnapshot(db, id);
          const { lobby, drawing } = snapshot;
          yield* requireHost(lobby, currentUser.id, "start a rematch");
          if (snapshot.phase !== "finished") {
            return yield* invalid("The current game hasn't finished yet");
          }
          // A rematch wipes the game it replaces, so its results must be
          // on record first — normally a read already did this.
          yield* settleIfOver(db, snapshot);
          // The typing race keeps `passage` (hidden while waiting — see
          // toApiLobby) so the next start can avoid repeating it; Sketchy
          // carries its prompts over in its settings for the same reason.
          const reset = yield* Effect.tryPromise(() =>
            db
              .update(gameLobbies)
              .set({
                status: "waiting",
                round: lobby.round + 1,
                startsAt: null,
                endsAt: null,
                updatedAt: new Date(),
                ...(drawing && {
                  settings: {
                    packs: drawing.settings.packs,
                    rounds: drawing.settings.rounds,
                    // Accumulates over rematches so a long session keeps
                    // cycling through the pool instead of ping-ponging.
                    recentPrompts: [
                      ...(drawing.settings.recentPrompts ?? []),
                      ...drawing.rows.drawings.map((row) => row.prompt),
                    ].slice(-RECENT_DEALT_CAP),
                  },
                }),
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
            // Bluffs and votes go with their drawings (cascade).
            yield* Effect.tryPromise(() =>
              db.delete(gameDrawings).where(eq(gameDrawings.lobbyId, id)),
            ).pipe(Effect.orDie);
            yield* notifyLobbyChanged(connections, lobby);
          }
          return yield* buildLobby(db, id, currentUser.id);
        }),
      )
      .handle("listDrawingPacks", () =>
        Effect.succeed({
          packs: DRAWING_PACKS.map((pack) => ({
            slug: pack.slug,
            name: pack.name,
            icon: pack.icon,
            description: pack.description,
            samples: pack.prompts.slice(0, 3),
            promptCount: pack.prompts.length,
          })),
        }),
      )
      .handle("updateDrawingSettings", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const lobby = yield* loadLobbyOr404(db, id);
          if (GAME_RULES[lobby.game as GameId].kind !== "drawing") {
            return yield* invalid("This game has no settings");
          }
          yield* requireHost(lobby, currentUser.id, "change the settings");
          if (lobby.status !== "waiting") {
            return yield* invalid(
              "Settings can only be changed before the game starts",
            );
          }
          const packs = [...new Set(payload.packs)];
          const unknown = packs.find((slug) => !findDrawingPack(slug));
          if (unknown !== undefined) {
            return yield* invalid(`Unknown theme pack: ${unknown}`);
          }
          const updated = yield* Effect.tryPromise(() =>
            db
              .update(gameLobbies)
              .set({
                settings: {
                  // In the picker's order, whatever order they were sent in.
                  packs: DRAWING_PACKS.map((pack) => pack.slug).filter((slug) =>
                    packs.includes(slug),
                  ),
                  rounds: payload.rounds,
                  recentPrompts: settingsOf(lobby).recentPrompts ?? [],
                },
                updatedAt: new Date(),
              })
              .where(
                and(eq(gameLobbies.id, id), eq(gameLobbies.status, "waiting")),
              )
              .returning({ id: gameLobbies.id }),
          ).pipe(Effect.orDie);
          if (updated.length === 0) {
            return yield* invalid(
              "Settings can only be changed before the game starts",
            );
          }
          yield* notifyLobbyChanged(connections, lobby);
          return yield* buildLobby(db, id, currentUser.id);
        }),
      )
      .handle("submitDrawing", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          yield* validateStrokes(payload.strokes);
          const snapshot = yield* loadSnapshot(db, id);
          const game = yield* requireDrawingGame(snapshot);
          yield* requireParticipant(game.rows, currentUser.id);
          const stage = drawStageAt(game.timeline, snapshot.now);
          if (!stage) return yield* invalid("It isn't time to draw");
          const mine = game.rows.drawings.find(
            (row) => row.turn === stage.turn && row.artistId === currentUser.id,
          );
          if (!mine) return yield* invalid("You have nothing to draw");
          const saved = yield* Effect.tryPromise(() =>
            db
              .update(gameDrawings)
              .set({
                strokes: payload.strokes,
                submittedAt: new Date(snapshot.now),
              })
              .where(
                and(
                  eq(gameDrawings.id, mine.id),
                  isNull(gameDrawings.submittedAt),
                ),
              )
              .returning({ id: gameDrawings.id }),
          ).pipe(Effect.orDie);
          if (saved.length === 0) {
            return yield* invalid("You already submitted your drawing");
          }
          yield* touchLobby(db, id);
          yield* notifyLobbyChanged(connections, snapshot.lobby);
          return yield* buildLobby(db, id, currentUser.id);
        }),
      )
      .handle("submitBluff", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const snapshot = yield* loadSnapshot(db, id);
          const game = yield* requireDrawingGame(snapshot);
          yield* requireParticipant(game.rows, currentUser.id);
          const drawing = spotlightAt(game, "bluff", snapshot.now);
          if (!drawing) return yield* invalid("It isn't time to bluff");
          if (drawing.artistId === currentUser.id) {
            return yield* invalid("You can't bluff on your own drawing");
          }
          const normalized = normalizeTitle(payload.text);
          if (normalized.length === 0) {
            return yield* invalid("Write a title with some words in it");
          }
          if (isTooCloseToPrompt(payload.text, drawing.prompt)) {
            return yield* invalid("Too close to the truth — try another.");
          }
          const bluffs = bluffsFor(game.rows, drawing.id);
          if (bluffs.some((bluff) => bluff.authorId === currentUser.id)) {
            return yield* invalid("You already wrote a bluff for this one");
          }
          if (
            bluffs.some((bluff) => normalizeTitle(bluff.text) === normalized)
          ) {
            return yield* invalid("Someone already wrote that — try another.");
          }
          // Stamped with the instant the stage was checked against, so the
          // timeline sees it land inside the stage (see `stageEnd`).
          const inserted = yield* Effect.tryPromise(() =>
            db
              .insert(gameBluffs)
              .values({
                drawingId: drawing.id,
                authorId: currentUser.id,
                text: payload.text,
                normalized,
                createdAt: new Date(snapshot.now),
              })
              .onConflictDoNothing()
              .returning({ id: gameBluffs.id }),
          ).pipe(Effect.orDie);
          // Lost a race with a double-submit or an identical bluff.
          if (inserted.length === 0) {
            return yield* invalid("Someone already wrote that — try another.");
          }
          yield* touchLobby(db, id);
          yield* notifyLobbyChanged(connections, snapshot.lobby);
          return yield* buildLobby(db, id, currentUser.id);
        }),
      )
      .handle("submitVote", ({ path: { id }, payload }) =>
        Effect.gen(function* () {
          const db = yield* Db;
          const currentUser = yield* CurrentUser;
          const connections = yield* RealtimeConnections;
          const snapshot = yield* loadSnapshot(db, id);
          const game = yield* requireDrawingGame(snapshot);
          yield* requireParticipant(game.rows, currentUser.id);
          const drawing = spotlightAt(game, "vote", snapshot.now);
          if (!drawing) return yield* invalid("It isn't time to vote");
          if (drawing.artistId === currentUser.id) {
            return yield* invalid("You can't vote on your own drawing");
          }
          const choice = buildBallot(drawing, bluffsFor(game.rows, drawing.id))[
            payload.answer
          ];
          if (!choice) return yield* invalid("That answer isn't on the ballot");
          if (choice.kind === "bluff" && choice.authorId === currentUser.id) {
            return yield* invalid("You can't vote for your own bluff");
          }
          const inserted = yield* Effect.tryPromise(() =>
            db
              .insert(gameVotes)
              .values({
                drawingId: drawing.id,
                voterId: currentUser.id,
                bluffId: choice.kind === "bluff" ? choice.bluffId : null,
                createdAt: new Date(snapshot.now),
              })
              .onConflictDoNothing()
              .returning({ id: gameVotes.id }),
          ).pipe(Effect.orDie);
          if (inserted.length === 0) {
            return yield* invalid("You already voted on this one");
          }
          yield* touchLobby(db, id);
          yield* notifyLobbyChanged(connections, snapshot.lobby);
          return yield* buildLobby(db, id, currentUser.id);
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
