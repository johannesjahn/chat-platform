import type { DrawingStroke } from "../../Api.ts";

// A Sketchy game as the pure modules here see it: the rows of
// `game_drawings`/`game_bluffs`/`game_votes` for one lobby, with timestamps
// as epoch ms. Everything a client is shown — the stage, the ballot, the
// scores — is a function of these plus the clock (see timeline.ts and
// view.ts), which is what lets every replica agree without a timer.

export type DrawingRow = {
  readonly id: number;
  readonly artistId: number;
  readonly turn: number;
  readonly position: number;
  readonly prompt: string;
  readonly shuffleSeed: number;
  readonly strokes: ReadonlyArray<DrawingStroke> | null;
  readonly submittedAt: number | null;
};

export type BluffRow = {
  readonly id: number;
  readonly drawingId: number;
  readonly authorId: number;
  readonly text: string;
  readonly createdAt: number;
};

export type VoteRow = {
  readonly drawingId: number;
  readonly voterId: number;
  // null: a vote for the real prompt.
  readonly bluffId: number | null;
  readonly createdAt: number;
};

export type DrawingGameRows = {
  readonly drawings: ReadonlyArray<DrawingRow>;
  readonly bluffs: ReadonlyArray<BluffRow>;
  readonly votes: ReadonlyArray<VoteRow>;
};

export const EMPTY_GAME_ROWS: DrawingGameRows = {
  drawings: [],
  bluffs: [],
  votes: [],
};

// Everyone dealt into the game, ascending — fixed at the start.
export const participantsOf = (rows: DrawingGameRows): number[] =>
  [...new Set(rows.drawings.map((drawing) => drawing.artistId))].sort(
    (a, b) => a - b,
  );

// Drawings in play order: round by round, and by slot within a round.
export const inPlayOrder = (
  drawings: ReadonlyArray<DrawingRow>,
): DrawingRow[] =>
  [...drawings].sort((a, b) => a.turn - b.turn || a.position - b.position);

export const bluffsFor = (rows: DrawingGameRows, drawingId: number) =>
  rows.bluffs.filter((bluff) => bluff.drawingId === drawingId);

export const votesFor = (rows: DrawingGameRows, drawingId: number) =>
  rows.votes.filter((vote) => vote.drawingId === drawingId);
