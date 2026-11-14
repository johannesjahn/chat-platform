import { asc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import {
  Forbidden,
  InvalidGameRequest,
  NotFound,
  type GameId,
  type GameLobby,
  type GameLobbyPhase,
  type ReflexGame,
} from "../Api.ts";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import {
  gameLobbies,
  gameLobbyPlayers,
  users,
  type DbGameLobby,
  type DbGameLobbyPlayer,
  type DrawingLobbySettings,
} from "../db/schema.ts";
import {
  EMPTY_GAME_ROWS,
  participantsOf,
  type DrawingGameRows,
} from "./drawing/model.ts";
import { DEFAULT_DRAWING_SETTINGS } from "./drawing/rules.ts";
import { guessAccuracy, placeOf, tallyScores } from "./drawing/scoring.ts";
import { loadDrawingRows } from "./drawing/store.ts";
import {
  buildTimeline,
  drawingPhase,
  type TimelineStage,
} from "./drawing/timeline.ts";
import { drawingSettingsOnly, projectDrawingGame } from "./drawing/view.ts";
import {
  buildReflexPlan,
  REFLEX_INTRO_MS,
  reflexSeedOf,
  type ReflexPlan,
} from "./reflex.ts";
import { GAME_RULES } from "./rules.ts";
import {
  gameHubRoom,
  gameLobbyRoom,
  RealtimeConnections,
} from "../Realtime.ts";

import { publicUserColumns, toPublicUser } from "../users/userViews.ts";

type PlayerRow = {
  readonly lobbyId: number;
  readonly joinedAt: Date;
  readonly durationMs: number | null;
  readonly score: number | null;
  readonly accuracy: number | null;
  readonly place: number | null;
  readonly detail: DbGameLobbyPlayer["detail"];
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

export const loadLobby = (db: DrizzleDb, id: number) =>
  dbQuery(() =>
    db.select().from(gameLobbies).where(eq(gameLobbies.id, id)).limit(1),
  ).pipe(Effect.map((rows) => rows[0] ?? null));

export const loadLobbyOr404 = (db: DrizzleDb, id: number) =>
  loadLobby(db, id).pipe(
    Effect.flatMap((lobby) =>
      lobby
        ? Effect.succeed(lobby)
        : Effect.fail(new NotFound({ message: "Lobby not found" })),
    ),
  );

// Seated players for each of `lobbyIds`, in join order, with the public user
// columns joined in for rendering.
export const loadPlayers = (db: DrizzleDb, lobbyIds: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const byLobby = new Map<number, PlayerRow[]>();
    if (lobbyIds.length === 0) return byLobby;
    const rows = yield* dbQuery(() =>
      db
        .select({
          lobbyId: gameLobbyPlayers.lobbyId,
          joinedAt: gameLobbyPlayers.joinedAt,
          durationMs: gameLobbyPlayers.durationMs,
          score: gameLobbyPlayers.score,
          accuracy: gameLobbyPlayers.accuracy,
          place: gameLobbyPlayers.place,
          detail: gameLobbyPlayers.detail,
          user: publicUserColumns,
        })
        .from(gameLobbyPlayers)
        .innerJoin(users, eq(users.id, gameLobbyPlayers.userId))
        .where(inArray(gameLobbyPlayers.lobbyId, [...lobbyIds]))
        .orderBy(asc(gameLobbyPlayers.joinedAt), asc(gameLobbyPlayers.id)),
    );
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
export type LobbySnapshot = {
  readonly lobby: DbGameLobby;
  readonly players: ReadonlyArray<PlayerRow>;
  readonly drawing: {
    readonly settings: DrawingLobbySettings;
    readonly rows: DrawingGameRows;
    // Empty until the game starts.
    readonly timeline: ReadonlyArray<TimelineStage>;
    // Whether `rows` carry the drawings' strokes (see `loadDrawingRows`) —
    // only a snapshot that does can be shown to a player.
    readonly withStrokes: boolean;
  } | null;
  // A started Reflex Rush game's schedule; null for every other game and
  // while waiting.
  readonly reflex: ReflexPlan | null;
  readonly phase: GameLobbyPhase;
  readonly now: number;
};

export const settingsOf = (lobby: DbGameLobby): DrawingLobbySettings =>
  lobby.settings ?? DEFAULT_DRAWING_SETTINGS;

const snapshotOf = (
  lobby: DbGameLobby,
  players: ReadonlyArray<PlayerRow>,
  rows: DrawingGameRows,
  now: number,
  withStrokes: boolean,
): LobbySnapshot => {
  const kind = GAME_RULES[lobby.game as GameId].kind;
  if (kind !== "drawing") {
    const seed =
      kind === "reflex" && lobby.status === "started"
        ? reflexSeedOf(lobby.passage)
        : null;
    return {
      lobby,
      players,
      drawing: null,
      reflex: seed === null ? null : buildReflexPlan(seed),
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
    drawing: { settings: settingsOf(lobby), rows, timeline, withStrokes },
    reflex: null,
    phase: started
      ? drawingPhase(lobby.startsAt!.getTime(), timeline, now)
      : "waiting",
    now,
  };
};

// Snapshots of several lobbies at once — players and Sketchy rows in a
// fixed number of queries, however many lobbies (the lobby browser).
// Strokes are only loaded `withStrokes` — for a response that shows the
// game to a player (`buildLobby`); everything else reads just the rest.
export const loadSnapshots = (
  db: DrizzleDb,
  lobbies: ReadonlyArray<DbGameLobby>,
  { withStrokes = false }: { withStrokes?: boolean } = {},
) =>
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
      { withStrokes },
    );
    const now = Date.now();
    return lobbies.map((lobby) =>
      snapshotOf(
        lobby,
        players.get(lobby.id) ?? [],
        rows.get(lobby.id) ?? EMPTY_GAME_ROWS,
        now,
        withStrokes,
      ),
    );
  });

export const loadSnapshot = (
  db: DrizzleDb,
  id: number,
  options?: { withStrokes?: boolean },
) =>
  loadLobbyOr404(db, id).pipe(
    Effect.flatMap((lobby) => loadSnapshots(db, [lobby], options)),
    Effect.map(([snapshot]) => snapshot!),
  );

// A finished Sketchy game's final standings — every drawing counted.
export const finalTallies = (snapshot: LobbySnapshot) => {
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
export const chatOpenFor = (snapshot: Pick<LobbySnapshot, "lobby" | "phase">) =>
  GAME_RULES[snapshot.lobby.game as GameId].chatDuringPlay ||
  snapshot.phase === "waiting" ||
  snapshot.phase === "finished";

// `viewerId` null builds the lobby browser's view: no passage, and only the
// settings of a Sketchy game.
export const toApiLobby = (
  snapshot: LobbySnapshot,
  viewerId: number | null,
): GameLobby => {
  const { lobby, players, drawing, reflex, phase, now } = snapshot;
  const rules = GAME_RULES[lobby.game as GameId];
  if (drawing && viewerId !== null && !drawing.withStrokes) {
    // A programming error, not a request error: projecting a game read
    // without its strokes would show every drawing as a blank canvas.
    throw new Error("A Sketchy game shown to a player needs its strokes");
  }
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
    // Only a race's passage is for showing — Reflex Rush keeps its seed in
    // the same column, and players get the schedule it lays out instead.
    passage:
      viewerId !== null && rules.kind === "race" && phase !== "waiting"
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
              place:
                rules.kind === "reflex"
                  ? reflexPlaceOf(players, player.score)
                  : player.place,
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
    reflex:
      rules.kind !== "reflex" || viewerId === null
        ? null
        : toApiReflex(lobby, players, phase === "waiting" ? null : reflex),
    chatOpen: chatOpenFor(snapshot),
    createdAt: lobby.createdAt.getTime(),
  };
};

// Reflex Rush places by score among those who've submitted — standings
// that settle as results come in, since everyone finishes at once and a
// later submission can outscore an earlier one. Ties share a place.
export const reflexPlaceOf = (
  players: ReadonlyArray<Pick<PlayerRow, "score">>,
  score: number | null,
) =>
  score === null
    ? null
    : players.filter((other) => other.score !== null && other.score > score)
        .length + 1;

const toApiReflex = (
  lobby: DbGameLobby,
  players: ReadonlyArray<PlayerRow>,
  plan: ReflexPlan | null,
): ReflexGame => {
  const startsAt = lobby.startsAt?.getTime() ?? 0;
  return {
    introMs: REFLEX_INTRO_MS,
    rounds: (plan?.rounds ?? []).map((round) => ({
      kind: round.kind,
      armAt: startsAt + round.armAt,
      signalAt: startsAt + round.signalAt,
      closeAt: startsAt + round.closeAt,
      cues: round.cues.map((cue) => ({
        at: startsAt + cue.at,
        variant: cue.variant,
      })),
      symbol: round.symbol,
      direction: round.direction,
      target: round.target,
    })),
    results: players.flatMap((player) =>
      player.detail
        ? [{ userId: player.user.id, rounds: player.detail.rounds }]
        : [],
    ),
  };
};

// Everyone looking at this lobby refetches it; everyone looking at the
// game's lobby browser refetches the list.
export const notifyLobbyChanged = (
  connections: RealtimeConnections["Service"],
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

export const touchLobby = (db: DrizzleDb, id: number, extra: object = {}) =>
  dbQuery(() =>
    db
      .update(gameLobbies)
      .set({ updatedAt: new Date(), ...extra })
      .where(eq(gameLobbies.id, id)),
  );

// createLobby/quickPlay read back a lobby they've only just created or
// joined, so a NotFound there is a defect (it was deleted in between), not a
// client error those endpoints document.
export const dieOnVanishedLobby = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf((e) => e instanceof NotFound, Effect.die),
  ) as Effect.Effect<A, Exclude<E, NotFound>, R>;

export const requireHost = (
  lobby: DbGameLobby,
  userId: number,
  action: string,
) =>
  lobby.hostId === userId
    ? Effect.void
    : Effect.fail(
        new Forbidden({ message: `Only the lobby host can ${action}` }),
      );

export const invalid = (message: string) =>
  Effect.fail(new InvalidGameRequest({ message }));
