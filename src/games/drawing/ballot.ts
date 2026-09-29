import type { BluffRow, DrawingRow, VoteRow } from "./model.ts";
import { shuffled, type RandomInt } from "./prompts.ts";

// One line on a drawing's vote ballot: its real prompt, or somebody's bluff.
export type BallotEntry =
  | { readonly kind: "real"; readonly text: string }
  | {
      readonly kind: "bluff";
      readonly bluffId: number;
      readonly authorId: number;
      readonly text: string;
    };

// mulberry32 — tiny, fast, and plenty for shuffling a handful of lines.
// What makes the order unguessable is the seed (random per drawing, never
// sent to clients), not the generator.
const seededRandomInt = (seed: number): RandomInt => {
  let state = seed >>> 0;
  return (maxExclusive) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let r = Math.imul(state ^ (state >>> 15), 1 | state);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    const unit = ((r ^ (r >>> 14)) >>> 0) / 0x1_0000_0000;
    return Math.floor(unit * maxExclusive);
  };
};

// The ballot in the order every voter sees it. Deterministic for a given
// drawing and set of bluffs — bluffs are taken in id order, not arrival
// order — so each read (on any replica) numbers the answers identically,
// and an answer's position is a stable id to vote with. The set of bluffs
// is frozen by the time a ballot is shown (bluffing is over), so positions
// can't shift under a voter.
export const buildBallot = (
  drawing: Pick<DrawingRow, "prompt" | "shuffleSeed">,
  bluffs: ReadonlyArray<BluffRow>,
): BallotEntry[] =>
  shuffled<BallotEntry>(
    [
      { kind: "real", text: drawing.prompt },
      ...[...bluffs]
        .sort((a, b) => a.id - b.id)
        .map((bluff) => ({
          kind: "bluff" as const,
          bluffId: bluff.id,
          authorId: bluff.authorId,
          text: bluff.text,
        })),
    ],
    seededRandomInt(drawing.shuffleSeed),
  );

// Which ballot line a vote points at.
export const ballotIndexOf = (
  ballot: ReadonlyArray<BallotEntry>,
  vote: Pick<VoteRow, "bluffId">,
): number =>
  ballot.findIndex((entry) =>
    vote.bluffId === null
      ? entry.kind === "real"
      : entry.kind === "bluff" && entry.bluffId === vote.bluffId,
  );

// The order the reveal turns answers over, as ballot indexes: every bluff
// that fooled somebody, least-picked first (ties in ballot order), and the
// truth last. A bluff nobody fell for isn't worth a beat of its own.
export const revealOrder = (
  ballot: ReadonlyArray<BallotEntry>,
  votes: ReadonlyArray<Pick<VoteRow, "bluffId">>,
): number[] => {
  const picks = ballot.map(
    (_, index) =>
      votes.filter((vote) => ballotIndexOf(ballot, vote) === index).length,
  );
  const fooled = ballot
    .map((entry, index) => ({ entry, index, picks: picks[index]! }))
    .filter(({ entry, picks }) => entry.kind === "bluff" && picks > 0)
    .sort((a, b) => a.picks - b.picks || a.index - b.index)
    .map(({ index }) => index);
  const real = ballot.findIndex((entry) => entry.kind === "real");
  return [...fooled, real];
};

// How many beats a drawing's reveal takes — `revealOrder(...).length`,
// without needing the prompt or the shuffle (the timeline only has counts).
export const revealStepCount = (
  bluffs: ReadonlyArray<Pick<BluffRow, "id">>,
  votes: ReadonlyArray<Pick<VoteRow, "bluffId">>,
): number => {
  const bluffIds = new Set(bluffs.map((bluff) => bluff.id));
  const fooling = new Set(
    votes
      .map((vote) => vote.bluffId)
      .filter((id): id is number => id !== null && bluffIds.has(id)),
  );
  return fooling.size + 1;
};
