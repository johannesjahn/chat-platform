import { asc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import type { DrizzleDb } from "../../Db.ts";
import { gameBluffs, gameDrawings, gameVotes } from "../../db/schema.ts";
import {
  EMPTY_GAME_ROWS,
  type BluffRow,
  type DrawingGameRows,
  type DrawingRow,
  type VoteRow,
} from "./model.ts";

type RowsBuilder = {
  drawings: DrawingRow[];
  bluffs: BluffRow[];
  votes: VoteRow[];
};

// Every drawing, bluff, and vote of the given lobbies' current games, three
// queries total however many lobbies are asked for (the lobby browser asks
// for a page of them at once).
export const loadDrawingRows = (
  db: DrizzleDb,
  lobbyIds: ReadonlyArray<number>,
) =>
  Effect.gen(function* () {
    const byLobby = new Map<number, RowsBuilder>();
    const result: ReadonlyMap<number, DrawingGameRows> = byLobby;
    if (lobbyIds.length === 0) return result;
    const ids = [...lobbyIds];

    const [drawings, bluffs, votes] = yield* Effect.all(
      [
        Effect.tryPromise(() =>
          db
            .select({
              id: gameDrawings.id,
              lobbyId: gameDrawings.lobbyId,
              artistId: gameDrawings.artistId,
              turn: gameDrawings.turn,
              position: gameDrawings.position,
              prompt: gameDrawings.prompt,
              shuffleSeed: gameDrawings.shuffleSeed,
              strokes: gameDrawings.strokes,
              submittedAt: gameDrawings.submittedAt,
            })
            .from(gameDrawings)
            .where(inArray(gameDrawings.lobbyId, ids))
            .orderBy(asc(gameDrawings.id)),
        ),
        Effect.tryPromise(() =>
          db
            .select({
              id: gameBluffs.id,
              lobbyId: gameDrawings.lobbyId,
              drawingId: gameBluffs.drawingId,
              authorId: gameBluffs.authorId,
              text: gameBluffs.text,
              createdAt: gameBluffs.createdAt,
            })
            .from(gameBluffs)
            .innerJoin(gameDrawings, eq(gameDrawings.id, gameBluffs.drawingId))
            .where(inArray(gameDrawings.lobbyId, ids))
            .orderBy(asc(gameBluffs.id)),
        ),
        Effect.tryPromise(() =>
          db
            .select({
              lobbyId: gameDrawings.lobbyId,
              drawingId: gameVotes.drawingId,
              voterId: gameVotes.voterId,
              bluffId: gameVotes.bluffId,
              createdAt: gameVotes.createdAt,
            })
            .from(gameVotes)
            .innerJoin(gameDrawings, eq(gameDrawings.id, gameVotes.drawingId))
            .where(inArray(gameDrawings.lobbyId, ids))
            .orderBy(asc(gameVotes.id)),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.orDie);

    const entry = (lobbyId: number): RowsBuilder => {
      let rows = byLobby.get(lobbyId);
      if (!rows) {
        rows = { drawings: [], bluffs: [], votes: [] };
        byLobby.set(lobbyId, rows);
      }
      return rows;
    };
    for (const { lobbyId, submittedAt, ...drawing } of drawings) {
      entry(lobbyId).drawings.push({
        ...drawing,
        submittedAt: submittedAt?.getTime() ?? null,
      });
    }
    for (const { lobbyId, createdAt, ...bluff } of bluffs) {
      entry(lobbyId).bluffs.push({ ...bluff, createdAt: createdAt.getTime() });
    }
    for (const { lobbyId, createdAt, ...vote } of votes) {
      entry(lobbyId).votes.push({ ...vote, createdAt: createdAt.getTime() });
    }
    return result;
  });

export const loadDrawingGame = (db: DrizzleDb, lobbyId: number) =>
  loadDrawingRows(db, [lobbyId]).pipe(
    Effect.map((rows) => rows.get(lobbyId) ?? EMPTY_GAME_ROWS),
  );
