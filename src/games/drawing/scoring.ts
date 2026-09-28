import type { BluffRow, DrawingRow, VoteRow } from "./model.ts";

// Sketchy's scoring table (issue #440). Entirely server-side: clients are
// only ever shown the outcome.
export const POINTS_FOR_TRUTH = 1000; // you picked the real prompt
export const POINTS_PER_FOOLED = 500; // per player who picked your bluff
export const POINTS_PER_GUESSED = 1000; // artist, per player who found the truth

export type DrawingOutcome = {
  // Points this drawing earned each player (only non-zero entries).
  readonly byUser: ReadonlyMap<number, number>;
  // What the real prompt earned the artist.
  readonly artistPoints: number;
  // What each bluff earned its author, by bluff id.
  readonly bluffPoints: ReadonlyMap<number, number>;
};

const add = (map: Map<number, number>, userId: number, points: number) => {
  if (points !== 0) map.set(userId, (map.get(userId) ?? 0) + points);
};

// Scores one drawing from its votes. The artist earns nothing when *nobody*
// or *everybody who voted* found the truth: that stops both an unreadable
// scribble and a drawing that just writes the answer in text from being
// the winning play.
export const scoreDrawing = (
  drawing: Pick<DrawingRow, "artistId">,
  bluffs: ReadonlyArray<Pick<BluffRow, "id" | "authorId">>,
  votes: ReadonlyArray<Pick<VoteRow, "voterId" | "bluffId">>,
): DrawingOutcome => {
  const byUser = new Map<number, number>();
  const bluffPoints = new Map<number, number>();
  const authors = new Map(bluffs.map((bluff) => [bluff.id, bluff.authorId]));

  let guessed = 0;
  for (const vote of votes) {
    if (vote.bluffId === null) {
      guessed++;
      add(byUser, vote.voterId, POINTS_FOR_TRUTH);
      continue;
    }
    const author = authors.get(vote.bluffId);
    // The handler never lets a vote land on its voter's own bluff; the
    // check here keeps the scoring honest on its own terms regardless.
    if (author === undefined || author === vote.voterId) continue;
    add(byUser, author, POINTS_PER_FOOLED);
    bluffPoints.set(
      vote.bluffId,
      (bluffPoints.get(vote.bluffId) ?? 0) + POINTS_PER_FOOLED,
    );
  }

  const artistPoints =
    guessed > 0 && guessed < votes.length ? guessed * POINTS_PER_GUESSED : 0;
  add(byUser, drawing.artistId, artistPoints);
  return { byUser, artistPoints, bluffPoints };
};

export type PlayerTally = {
  readonly userId: number;
  readonly score: number;
  // Votes cast, and how many of them found the real prompt.
  readonly guesses: number;
  readonly correctGuesses: number;
};

// Running totals for every participant over the drawings `counted` says to
// include (the finished reveals, or all of them at the end), highest score
// first, ties by user id so the order is stable.
export const tallyScores = (
  participants: ReadonlyArray<number>,
  drawings: ReadonlyArray<DrawingRow>,
  bluffs: ReadonlyArray<BluffRow>,
  votes: ReadonlyArray<VoteRow>,
  counted: (drawing: DrawingRow) => boolean,
): PlayerTally[] => {
  const scores = new Map(participants.map((id) => [id, 0]));
  const guesses = new Map(participants.map((id) => [id, 0]));
  const correct = new Map(participants.map((id) => [id, 0]));
  for (const drawing of drawings) {
    if (!counted(drawing)) continue;
    const drawingVotes = votes.filter((vote) => vote.drawingId === drawing.id);
    const outcome = scoreDrawing(
      drawing,
      bluffs.filter((bluff) => bluff.drawingId === drawing.id),
      drawingVotes,
    );
    for (const [userId, points] of outcome.byUser) {
      scores.set(userId, (scores.get(userId) ?? 0) + points);
    }
    for (const vote of drawingVotes) {
      guesses.set(vote.voterId, (guesses.get(vote.voterId) ?? 0) + 1);
      if (vote.bluffId === null) {
        correct.set(vote.voterId, (correct.get(vote.voterId) ?? 0) + 1);
      }
    }
  }
  return [...scores]
    .map(([userId, score]) => ({
      userId,
      score,
      guesses: guesses.get(userId) ?? 0,
      correctGuesses: correct.get(userId) ?? 0,
    }))
    .sort((a, b) => b.score - a.score || a.userId - b.userId);
};

// Standard competition ranking ("1, 2, 2, 4"): tied scores share a place.
export const placeOf = (
  tallies: ReadonlyArray<Pick<PlayerTally, "score">>,
  score: number,
): number => 1 + tallies.filter((tally) => tally.score > score).length;

// The share of a player's votes that found the truth, as a percentage —
// Sketchy's `accuracy` on the results and leaderboard.
export const guessAccuracy = (
  tally: Pick<PlayerTally, "guesses" | "correctGuesses">,
): number =>
  tally.guesses === 0
    ? 0
    : Math.round((tally.correctGuesses / tally.guesses) * 1000) / 10;
