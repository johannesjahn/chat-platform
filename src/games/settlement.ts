import { and, asc, desc, eq, isNull, ne, or } from "drizzle-orm";
import { Effect } from "effect";
import { type DrizzleDb, dbQuery } from "../Db.ts";
import { gameLobbies, gameResults } from "../db/schema.ts";
import { guessAccuracy, placeOf } from "./drawing/scoring.ts";
import {
  createNotifications,
  type NotificationDeps,
} from "../notifications.ts";
import {
  finalTallies,
  loadSnapshot,
  reflexPlaceOf,
  toApiLobby,
  type LobbySnapshot,
} from "./lobbyStore.ts";

// The full lobby as its own page renders it for `viewerId` — passage
// included once a race is underway, a Sketchy game filtered down to what
// the viewer may see. The first read to find a Sketchy game over also
// settles its results (see `settleDrawingGame`).
export const buildLobby = (
  deps: NotificationDeps,
  id: number,
  viewerId: number,
) =>
  Effect.gen(function* () {
    const snapshot = yield* loadSnapshot(deps.db, id, { withStrokes: true });
    yield* settleIfOver(deps, snapshot);
    return toApiLobby(snapshot, viewerId);
  });

// The player holding `game`'s all-time best score right now (earliest to
// reach it on a tie), or null before anyone has finished a race.
export const currentRecordHolder = (db: DrizzleDb, game: string) =>
  dbQuery(() =>
    db
      .select({ userId: gameResults.userId, score: gameResults.score })
      .from(gameResults)
      .where(eq(gameResults.game, game))
      .orderBy(desc(gameResults.score), asc(gameResults.id))
      .limit(1),
  ).pipe(Effect.map((rows) => rows[0] ?? null));

// Tells the holder of `game`'s all-time best (as it stood before `results`
// were recorded) that they've lost it, if one of `results` took it from
// them — the one leaderboard change worth a notification, since it's the
// one they'd want to win back. Improving your own record is silent.
export const notifyRecordBroken = (
  deps: NotificationDeps,
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
    yield* createNotifications(deps, [
      {
        userId: previous.userId,
        actorId: best.userId,
        type: "game_record",
        game,
        lobbyId,
      },
    ]);
  });

// The `game_results` rows a finished game scored all at once at the end
// records — null for a race, whose finishes are recorded as they land.
// Only players still seated at the end are recorded — leaving mid-game
// forfeits.
const settledResults = (snapshot: LobbySnapshot, startsAt: Date) => {
  const { lobby, drawing, reflex, players } = snapshot;
  if (drawing) {
    const tallies = finalTallies(snapshot);
    const seated = new Set(players.map((player) => player.user.id));
    const endsAt = drawing.timeline.at(-1)?.endsAt ?? startsAt.getTime();
    return tallies
      .filter((tally) => seated.has(tally.userId))
      .map((tally) => ({
        game: lobby.game,
        userId: tally.userId,
        lobbyId: lobby.id,
        round: lobby.round,
        score: tally.score,
        accuracy: guessAccuracy(tally),
        durationMs: endsAt - startsAt.getTime(),
        place: placeOf(tallies, tally.score),
        playerCount: tallies.length,
      }));
  }
  if (reflex) {
    // Anyone who never submitted simply has no result — their seat still
    // counts toward the field they'd have beaten.
    return players.flatMap((player) =>
      player.score === null ||
      player.accuracy === null ||
      player.durationMs === null
        ? []
        : [
            {
              game: lobby.game,
              userId: player.user.id,
              lobbyId: lobby.id,
              round: lobby.round,
              score: player.score,
              accuracy: player.accuracy,
              durationMs: player.durationMs,
              place: reflexPlaceOf(players, player.score)!,
              playerCount: players.length,
            },
          ],
    );
  }
  return null;
};

// Records a finished game's results (Sketchy's, Reflex Rush's) — exactly
// once, whichever read gets here first on whichever replica: claiming the
// round in `settled_round` and inserting its `game_results` share one
// transaction, and the claim is conditional, so a concurrent settle finds
// nothing left to claim.
export const settleIfOver = (deps: NotificationDeps, snapshot: LobbySnapshot) =>
  Effect.gen(function* () {
    const { db } = deps;
    const { lobby, phase } = snapshot;
    if (phase !== "finished" || !lobby.startsAt) return;
    if (lobby.settledRound === lobby.round) return;
    const results = settledResults(snapshot, lobby.startsAt);
    if (!results) return;

    const record = yield* currentRecordHolder(db, lobby.game);
    const settled = yield* dbQuery(() =>
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
    );
    if (settled) {
      yield* notifyRecordBroken(deps, lobby.game, lobby.id, record, results);
    }
  });
