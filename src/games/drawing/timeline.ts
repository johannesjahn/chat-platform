import type { DrawingStageKind, GameLobbyPhase } from "../../Api.ts";
import { revealStepCount } from "./ballot.ts";
import {
  bluffsFor,
  inPlayOrder,
  participantsOf,
  votesFor,
  type DrawingGameRows,
} from "./model.ts";

// How long each stage runs when not everyone submits early.
export const DRAW_STAGE_MS = 75_000;
export const BLUFF_STAGE_MS = 45_000;
export const VOTE_STAGE_MS = 20_000;
// A reveal: a beat to take the ballot in, one beat per answer turned over
// (see `revealOrder`), then a hold on the truth and the points.
export const REVEAL_LEAD_MS = 1_500;
export const REVEAL_STEP_MS = 2_600;
export const REVEAL_HOLD_MS = 4_500;

export const revealDurationMs = (steps: number) =>
  REVEAL_LEAD_MS + steps * REVEAL_STEP_MS + REVEAL_HOLD_MS;

export type TimelineStage = {
  readonly kind: DrawingStageKind;
  readonly turn: number;
  readonly drawingId: number | null;
  readonly startedAt: number;
  readonly endsAt: number;
};

// A stage runs its full `durationMs` unless every required submission is in
// before then, in which case it ends the moment the last one landed. A
// submission can only be accepted while its stage is current, so once a
// stage is over its end never moves again — the property that makes this
// safe to recompute on every read.
const stageEnd = (
  startedAt: number,
  durationMs: number,
  submittedAt: ReadonlyArray<number | null>,
  required: number,
): number => {
  const deadline = startedAt + durationMs;
  const landed = submittedAt.filter((at): at is number => at !== null);
  if (required === 0 || landed.length < required) return deadline;
  const lastIn = Math.max(...landed);
  return lastIn < deadline ? Math.max(startedAt, lastIn) : deadline;
};

// The whole game as a sequence of stages, derived from the start time and
// the submission rows alone — never written by a timer, so every replica
// computes the same schedule, and a page reloaded mid-round lands in the
// right place. Stages still in the future are provisional: they're laid out
// at full length, and can only get shorter.
//
// Per round: one "draw" stage for everyone, then for each of the round's
// drawings in turn, "bluff" → "vote" → "reveal". A vote over a drawing
// nobody bluffed on has nothing to choose between, so it takes no time at
// all (and, being zero-length, is never the current stage).
export const buildTimeline = (
  startsAt: number,
  rows: DrawingGameRows,
): TimelineStage[] => {
  const participants = participantsOf(rows);
  const drawings = inPlayOrder(rows.drawings);
  const turns = [...new Set(drawings.map((drawing) => drawing.turn))];
  const stages: TimelineStage[] = [];
  let cursor = startsAt;

  const push = (stage: Omit<TimelineStage, "endsAt">, endsAt: number) => {
    stages.push({ ...stage, endsAt });
    cursor = endsAt;
  };

  for (const turn of turns) {
    const round = drawings.filter((drawing) => drawing.turn === turn);
    push(
      { kind: "draw", turn, drawingId: null, startedAt: cursor },
      stageEnd(
        cursor,
        DRAW_STAGE_MS,
        round.map((drawing) => drawing.submittedAt),
        round.length,
      ),
    );

    for (const drawing of round) {
      const bluffs = bluffsFor(rows, drawing.id);
      const votes = votesFor(rows, drawing.id);
      // Everyone but the artist bluffs and votes.
      const guessers = participants.filter((id) => id !== drawing.artistId);
      const common = { turn, drawingId: drawing.id };

      push(
        { ...common, kind: "bluff", startedAt: cursor },
        stageEnd(
          cursor,
          BLUFF_STAGE_MS,
          bluffs.map((bluff) => bluff.createdAt),
          guessers.length,
        ),
      );
      push(
        { ...common, kind: "vote", startedAt: cursor },
        bluffs.length === 0
          ? cursor
          : stageEnd(
              cursor,
              VOTE_STAGE_MS,
              votes.map((vote) => vote.createdAt),
              guessers.length,
            ),
      );
      push(
        { ...common, kind: "reveal", startedAt: cursor },
        cursor + revealDurationMs(revealStepCount(bluffs, votes)),
      );
    }
  }
  return stages;
};

// The stage in progress at `now`, or null before the first one starts or
// after the last one ends. Zero-length stages are never current.
export const currentStage = (
  timeline: ReadonlyArray<TimelineStage>,
  now: number,
): TimelineStage | null =>
  timeline.find((stage) => stage.startedAt <= now && now < stage.endsAt) ??
  null;

export const stageOf = (
  timeline: ReadonlyArray<TimelineStage>,
  kind: DrawingStageKind,
  match: { readonly turn?: number; readonly drawingId?: number },
): TimelineStage | undefined =>
  timeline.find(
    (stage) =>
      stage.kind === kind &&
      (match.turn === undefined || stage.turn === match.turn) &&
      (match.drawingId === undefined || stage.drawingId === match.drawingId),
  );

// The lobby phase for a started Sketchy game — the counterpart of the typing
// race's `lobbyPhase`: "countdown" until `startsAt`, "racing" while any
// stage is still to come, then "finished".
export const drawingPhase = (
  startsAt: number,
  timeline: ReadonlyArray<TimelineStage>,
  now: number,
): Exclude<GameLobbyPhase, "waiting"> => {
  if (now < startsAt) return "countdown";
  const end = timeline.at(-1)?.endsAt ?? startsAt;
  return now < end ? "racing" : "finished";
};

// The latest a game can possibly end — every stage running its full timer,
// every reveal as long as it can be. Stored as the lobby's `endsAt` at the
// start, as an upper bound.
export const worstCaseDurationMs = (players: number, rounds: number): number =>
  rounds *
  (DRAW_STAGE_MS +
    players *
      (BLUFF_STAGE_MS +
        VOTE_STAGE_MS +
        revealDurationMs(Math.max(players, 1))));
