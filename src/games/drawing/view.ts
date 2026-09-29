import type { DrawingAnswer, DrawingEntry, DrawingGame } from "../../Api.ts";
import type { DrawingLobbySettings } from "../../db/schema.ts";
import { ballotIndexOf, buildBallot, revealOrder } from "./ballot.ts";
import {
  bluffsFor,
  inPlayOrder,
  participantsOf,
  votesFor,
  type DrawingGameRows,
  type DrawingRow,
} from "./model.ts";
import { scoreDrawing, tallyScores } from "./scoring.ts";
import {
  currentStage,
  REVEAL_LEAD_MS,
  REVEAL_STEP_MS,
  stageOf,
  type TimelineStage,
} from "./timeline.ts";

// The one place a Sketchy game is turned into what a particular viewer may
// see. Every secret is gated on the clock-derived timeline, never on who is
// asking, except where the viewer already knows the answer:
//
//  - a drawing's prompt: only from that drawing's reveal on — though its
//    artist sees their own as soon as its round starts;
//  - a drawing's strokes: from its bluff stage on (its artist: once drawn);
//  - the ballot: from the vote stage on, with nothing that tells the real
//    title from a bluff until the reveal;
//  - who wrote which bluff and who voted for what: only at the reveal;
//  - a round that hasn't started: not listed at all.
//
// A spectator (not dealt in) and a player are held to the same rules.
// Scores only count a drawing once its reveal has finished playing out, so
// the scoreboard can't spoil a reveal in progress.
export const projectDrawingGame = ({
  settings,
  rows,
  timeline,
  now,
  finished,
  viewerId,
}: {
  settings: DrawingLobbySettings;
  rows: DrawingGameRows;
  timeline: ReadonlyArray<TimelineStage>;
  now: number;
  finished: boolean;
  viewerId: number;
}): DrawingGame => {
  const stage = finished ? null : currentStage(timeline, now);
  const reached = (at: TimelineStage | undefined) =>
    finished || (at !== undefined && at.startedAt <= now);
  const over = (at: TimelineStage | undefined) =>
    finished || (at !== undefined && at.endsAt <= now);

  const participants = participantsOf(rows);
  const visible = inPlayOrder(rows.drawings).filter((drawing) =>
    reached(stageOf(timeline, "draw", { turn: drawing.turn })),
  );

  const myDrawing =
    stage?.kind === "draw"
      ? rows.drawings.find(
          (drawing) =>
            drawing.turn === stage.turn && drawing.artistId === viewerId,
        )
      : undefined;

  const scores = tallyScores(
    participants,
    rows.drawings,
    rows.bluffs,
    rows.votes,
    (drawing) => over(stageOf(timeline, "reveal", { drawingId: drawing.id })),
  );

  return {
    packs: [...settings.packs],
    rounds: settings.rounds,
    stage: stage && {
      kind: stage.kind,
      turn: stage.turn,
      drawingId: stage.drawingId,
      startedAt: stage.startedAt,
      endsAt: stage.endsAt,
    },
    myPrompt: myDrawing?.prompt ?? null,
    participantIds: participants,
    drawings: visible.map((drawing) =>
      projectDrawing(drawing, {
        rows,
        viewerId,
        strokesVisible:
          reached(stageOf(timeline, "bluff", { drawingId: drawing.id })) ||
          (drawing.artistId === viewerId && drawing.submittedAt !== null),
        ballotVisible: reached(
          stageOf(timeline, "vote", { drawingId: drawing.id }),
        ),
        reveal: finished
          ? { startedAt: -Infinity }
          : (() => {
              const at = stageOf(timeline, "reveal", {
                drawingId: drawing.id,
              });
              return at && at.startedAt <= now
                ? { startedAt: at.startedAt }
                : null;
            })(),
      }),
    ),
    scores: scores.map(({ userId, score }) => ({ userId, score })),
  };
};

const projectDrawing = (
  drawing: DrawingRow,
  {
    rows,
    viewerId,
    strokesVisible,
    ballotVisible,
    reveal,
  }: {
    rows: DrawingGameRows;
    viewerId: number;
    strokesVisible: boolean;
    ballotVisible: boolean;
    // When the reveal started (−∞ once the game is over), or null before.
    reveal: { readonly startedAt: number } | null;
  },
): DrawingEntry => {
  const bluffs = bluffsFor(rows, drawing.id);
  const votes = votesFor(rows, drawing.id);
  const isArtist = drawing.artistId === viewerId;
  const ballot = buildBallot(drawing, bluffs);
  const myVote = votes.find((vote) => vote.voterId === viewerId);

  let answers: DrawingAnswer[] | null = null;
  if (ballotVisible || reveal) {
    const outcome = reveal ? scoreDrawing(drawing, bluffs, votes) : null;
    const order = reveal ? revealOrder(ballot, votes) : [];
    answers = ballot.map((entry, index) => {
      const mine =
        entry.kind === "real" ? isArtist : entry.authorId === viewerId;
      if (!reveal || !outcome) {
        return {
          id: index,
          text: entry.text,
          mine,
          real: null,
          authorId: null,
          voterIds: null,
          points: null,
          revealAt: null,
        };
      }
      const step = order.indexOf(index);
      return {
        id: index,
        text: entry.text,
        mine,
        real: entry.kind === "real",
        authorId: entry.kind === "real" ? null : entry.authorId,
        voterIds: votes
          .filter((vote) => ballotIndexOf(ballot, vote) === index)
          .map((vote) => vote.voterId),
        points:
          entry.kind === "real"
            ? outcome.artistPoints
            : (outcome.bluffPoints.get(entry.bluffId) ?? 0),
        revealAt:
          step === -1 || reveal.startedAt === -Infinity
            ? null
            : reveal.startedAt + REVEAL_LEAD_MS + step * REVEAL_STEP_MS,
      };
    });
  }

  return {
    id: drawing.id,
    turn: drawing.turn,
    position: drawing.position,
    artistId: drawing.artistId,
    submitted: drawing.submittedAt !== null,
    strokes: strokesVisible ? (drawing.strokes ?? []) : null,
    prompt: reveal || isArtist ? drawing.prompt : null,
    revealed: reveal !== null,
    bluffCount: bluffs.length,
    voteCount: votes.length,
    myBluff: bluffs.find((bluff) => bluff.authorId === viewerId)?.text ?? null,
    myVote: myVote ? ballotIndexOf(ballot, myVote) : null,
    answers,
  };
};

// What the lobby browser shows of a Sketchy lobby: its settings, nothing
// about any game in progress.
export const drawingSettingsOnly = (
  settings: DrawingLobbySettings,
): DrawingGame => ({
  packs: [...settings.packs],
  rounds: settings.rounds,
  stage: null,
  myPrompt: null,
  participantIds: [],
  drawings: [],
  scores: [],
});
