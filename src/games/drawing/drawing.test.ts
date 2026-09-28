import { describe, expect, test } from "bun:test";
import { buildBallot, revealOrder, revealStepCount } from "./ballot.ts";
import type {
  BluffRow,
  DrawingGameRows,
  DrawingRow,
  VoteRow,
} from "./model.ts";
import { DRAWING_PACKS, promptPool } from "./packs/index.ts";
import {
  dealPrompts,
  editDistance,
  isTooCloseToPrompt,
  normalizeTitle,
} from "./prompts.ts";
import {
  guessAccuracy,
  placeOf,
  POINTS_FOR_TRUTH,
  POINTS_PER_FOOLED,
  POINTS_PER_GUESSED,
  scoreDrawing,
  tallyScores,
} from "./scoring.ts";
import {
  BLUFF_STAGE_MS,
  buildTimeline,
  currentStage,
  DRAW_STAGE_MS,
  drawingPhase,
  revealDurationMs,
  worstCaseDurationMs,
} from "./timeline.ts";
import { projectDrawingGame } from "./view.ts";

const drawing = (
  overrides: Partial<DrawingRow> & { id: number },
): DrawingRow => ({
  artistId: 1,
  turn: 1,
  position: 0,
  prompt: `prompt ${overrides.id}`,
  shuffleSeed: 12345 + overrides.id,
  strokes: null,
  submittedAt: null,
  ...overrides,
});

const bluff = (
  overrides: Partial<BluffRow> & {
    id: number;
    drawingId: number;
    authorId: number;
  },
): BluffRow => ({
  text: `bluff ${overrides.id}`,
  createdAt: 0,
  ...overrides,
});

const vote = (
  overrides: Partial<VoteRow> & { drawingId: number; voterId: number },
): VoteRow => ({ bluffId: null, createdAt: 0, ...overrides });

describe("theme packs", () => {
  test("every pack is well-formed and deep enough for a full game", () => {
    const slugs = DRAWING_PACKS.map((pack) => pack.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const pack of DRAWING_PACKS) {
      // 8 players x 3 rounds from a single pack, with room to spare.
      expect(pack.prompts.length).toBeGreaterThanOrEqual(60);
      expect(new Set(pack.prompts).size).toBe(pack.prompts.length);
      expect([...pack.icon].length).toBeLessThanOrEqual(2);
      for (const prompt of pack.prompts) {
        // Plain ASCII, lowercase-first, no stray whitespace.
        expect(prompt).toMatch(/^[a-z][\x20-\x7e]*[A-Za-z]$/);
        expect(prompt).not.toMatch(/\s{2}/);
      }
    }
  });

  test("the prompt pool is the de-duplicated union of the chosen packs", () => {
    const pool = promptPool(["classics", "animals", "classics", "nope"]);
    expect(new Set(pool).size).toBe(pool.length);
    expect(pool.length).toBe(
      new Set([...DRAWING_PACKS[0]!.prompts, ...DRAWING_PACKS[1]!.prompts])
        .size,
    );
  });
});

describe("prompts", () => {
  test("titles fold case, accents, punctuation and leading articles", () => {
    expect(normalizeTitle("  The Café's   GRAND opening!! ")).toBe(
      "cafe s grand opening",
    );
    expect(normalizeTitle("A cat")).toBe("cat");
    // A lone article is still a word, not nothing.
    expect(normalizeTitle("The")).toBe("the");
    expect(normalizeTitle("?!…")).toBe("");
  });

  test("edit distance", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });

  test("a bluff that is the prompt in disguise is too close", () => {
    const prompt = "a cat filing its taxes";
    for (const bluff of [
      "A cat filing its taxes",
      "the cat filing its taxes!",
      "cat filling its taxes", // a typo
      "cats filing its taxes", // a plural
      "its taxes filing a cat", // reordered
      "catfilingitstaxes",
    ]) {
      expect(isTooCloseToPrompt(bluff, prompt)).toBe(true);
    }
    for (const bluff of [
      "a dog filing its taxes",
      "a cat eating its homework",
      "tax season",
    ]) {
      expect(isTooCloseToPrompt(bluff, prompt)).toBe(false);
    }
    // Short prompts get no typo tolerance — "bat" is a fair bluff for "cat".
    expect(isTooCloseToPrompt("bat", "cat")).toBe(false);
  });

  test("a deal is distinct, avoids recent prompts, and knows when it can't", () => {
    const pool = ["a", "b", "c", "d", "e"];
    const deal = dealPrompts(pool, 3, ["a", "b"])!;
    expect(new Set(deal).size).toBe(3);
    expect(deal.sort()).toEqual(["c", "d", "e"]);
    // Falls back to recent prompts only once the fresh ones run out.
    expect(dealPrompts(pool, 5, ["a", "b"])!.sort()).toEqual(pool);
    expect(dealPrompts(pool, 6, [])).toBeNull();
  });
});

describe("ballot", () => {
  const art = drawing({ id: 7, prompt: "the real one" });
  const bluffs = [
    bluff({ id: 3, drawingId: 7, authorId: 2, text: "fake two" }),
    bluff({ id: 1, drawingId: 7, authorId: 3, text: "fake three" }),
  ];

  test("lists the truth among the bluffs, in the same order on every read", () => {
    const ballot = buildBallot(art, bluffs);
    expect(ballot.map((entry) => entry.text).sort()).toEqual([
      "fake three",
      "fake two",
      "the real one",
    ]);
    // Arrival order doesn't matter, only the rows.
    expect(buildBallot(art, [...bluffs].reverse())).toEqual(ballot);
  });

  test("the truth isn't always in the same slot", () => {
    const slots = new Set(
      Array.from({ length: 40 }, (_, seed) =>
        buildBallot({ ...art, shuffleSeed: seed * 7919 }, bluffs).findIndex(
          (entry) => entry.kind === "real",
        ),
      ),
    );
    expect(slots.size).toBe(3);
  });

  test("the reveal turns over fooling bluffs least-picked first, the truth last", () => {
    const ballot = buildBallot(art, bluffs);
    const votes = [
      vote({ drawingId: 7, voterId: 4, bluffId: 3 }),
      vote({ drawingId: 7, voterId: 5, bluffId: 3 }),
      vote({ drawingId: 7, voterId: 6, bluffId: 1 }),
      vote({ drawingId: 7, voterId: 8 }),
    ];
    const order = revealOrder(ballot, votes).map((i) => ballot[i]!.text);
    expect(order).toEqual(["fake three", "fake two", "the real one"]);
    expect(revealStepCount(bluffs, votes)).toBe(3);
    // A bluff nobody picked gets no beat.
    expect(
      revealOrder(ballot, [vote({ drawingId: 7, voterId: 4 })]).map(
        (i) => ballot[i]!.text,
      ),
    ).toEqual(["the real one"]);
  });
});

describe("scoring", () => {
  const bluffs = [
    { id: 10, authorId: 2 },
    { id: 11, authorId: 3 },
  ];

  test("truth-finders, fooling bluffers, and the artist all score", () => {
    const outcome = scoreDrawing({ artistId: 1 }, bluffs, [
      { voterId: 2, bluffId: null },
      { voterId: 3, bluffId: 10 },
      { voterId: 4, bluffId: 10 },
    ]);
    expect(outcome.byUser.get(2)).toBe(
      POINTS_FOR_TRUTH + 2 * POINTS_PER_FOOLED,
    );
    expect(outcome.byUser.get(3)).toBeUndefined();
    expect(outcome.artistPoints).toBe(POINTS_PER_GUESSED);
    expect(outcome.byUser.get(1)).toBe(POINTS_PER_GUESSED);
    expect(outcome.bluffPoints.get(10)).toBe(2 * POINTS_PER_FOOLED);
  });

  test("the artist earns nothing when nobody — or everybody — guessed it", () => {
    expect(
      scoreDrawing({ artistId: 1 }, bluffs, [
        { voterId: 2, bluffId: 11 },
        { voterId: 3, bluffId: 10 },
      ]).artistPoints,
    ).toBe(0);
    expect(
      scoreDrawing({ artistId: 1 }, bluffs, [
        { voterId: 2, bluffId: null },
        { voterId: 3, bluffId: null },
      ]).artistPoints,
    ).toBe(0);
  });

  test("a vote for your own bluff never pays", () => {
    const outcome = scoreDrawing({ artistId: 1 }, bluffs, [
      { voterId: 2, bluffId: 10 },
    ]);
    expect(outcome.byUser.size).toBe(0);
  });

  test("tallies rank players, share places on ties, and track guess accuracy", () => {
    const drawings = [drawing({ id: 1, artistId: 1 })];
    const tallies = tallyScores(
      [1, 2, 3],
      drawings,
      [bluff({ id: 5, drawingId: 1, authorId: 2 })],
      [
        vote({ drawingId: 1, voterId: 2 }),
        vote({ drawingId: 1, voterId: 3, bluffId: 5 }),
      ],
      () => true,
    );
    expect(tallies.map((t) => [t.userId, t.score])).toEqual([
      [2, 1500],
      [1, 1000],
      [3, 0],
    ]);
    expect(placeOf(tallies, 1000)).toBe(2);
    expect(guessAccuracy(tallies[0]!)).toBe(100);
    expect(guessAccuracy(tallies[2]!)).toBe(0);
    expect(
      tallyScores([1, 2], drawings, [], [], () => false).map((t) => t.score),
    ).toEqual([0, 0]);
    expect(placeOf([{ score: 5 }, { score: 5 }, { score: 1 }], 5)).toBe(1);
  });
});

describe("timeline", () => {
  const START = 1_000_000;
  const players = [1, 2, 3];
  const oneRound = (
    overrides: Partial<DrawingGameRows> = {},
  ): DrawingGameRows => ({
    drawings: players.map((artistId, position) =>
      drawing({ id: artistId * 10, artistId, position }),
    ),
    bluffs: [],
    votes: [],
    ...overrides,
  });

  test("with nobody submitting, every stage runs its full timer", () => {
    const timeline = buildTimeline(START, oneRound());
    expect(timeline.map((stage) => stage.kind)).toEqual([
      "draw",
      ...players.flatMap(() => ["bluff", "vote", "reveal"]),
    ]);
    expect(timeline[0]).toMatchObject({
      startedAt: START,
      endsAt: START + DRAW_STAGE_MS,
      drawingId: null,
    });
    const firstBluff = timeline[1]!;
    expect(firstBluff.endsAt - firstBluff.startedAt).toBe(BLUFF_STAGE_MS);
    // Nothing to vote between, so the vote takes no time at all...
    expect(timeline[2]!.endsAt).toBe(timeline[2]!.startedAt);
    // ...and is never the current stage.
    expect(currentStage(timeline, timeline[2]!.startedAt)?.kind).toBe("reveal");
    expect(timeline[3]!.endsAt - timeline[3]!.startedAt).toBe(
      revealDurationMs(1),
    );
  });

  test("a stage ends the moment its last submission lands", () => {
    const rows = oneRound({
      drawings: players.map((artistId, position) =>
        drawing({
          id: artistId * 10,
          artistId,
          position,
          submittedAt: START + 1_000 * artistId,
        }),
      ),
      bluffs: [
        bluff({ id: 1, drawingId: 10, authorId: 2, createdAt: START + 5_000 }),
        bluff({ id: 2, drawingId: 10, authorId: 3, createdAt: START + 6_000 }),
      ],
      votes: [
        vote({ drawingId: 10, voterId: 2, createdAt: START + 7_000 }),
        vote({
          drawingId: 10,
          voterId: 3,
          bluffId: 1,
          createdAt: START + 8_000,
        }),
      ],
    });
    const [draw, bluffStage, voteStage, reveal] = buildTimeline(START, rows);
    expect(draw!.endsAt).toBe(START + 3_000);
    expect(bluffStage!.endsAt).toBe(START + 6_000);
    expect(voteStage).toMatchObject({
      kind: "vote",
      drawingId: 10,
      startedAt: START + 6_000,
      endsAt: START + 8_000,
    });
    // One bluff fooled someone, plus the truth: two beats.
    expect(reveal!.endsAt - reveal!.startedAt).toBe(revealDurationMs(2));
  });

  test("a submission after the timer (the draw grace) doesn't move the stage", () => {
    const rows = oneRound({
      drawings: players.map((artistId, position) =>
        drawing({
          id: artistId * 10,
          artistId,
          position,
          submittedAt:
            artistId === 3 ? START + DRAW_STAGE_MS + 500 : START + 1_000,
        }),
      ),
    });
    expect(buildTimeline(START, rows)[0]!.endsAt).toBe(START + DRAW_STAGE_MS);
  });

  test("partial submissions leave the timer running", () => {
    const rows = oneRound({
      bluffs: [bluff({ id: 1, drawingId: 10, authorId: 2, createdAt: START })],
    });
    const bluffStage = buildTimeline(START, rows)[1]!;
    expect(bluffStage.endsAt - bluffStage.startedAt).toBe(BLUFF_STAGE_MS);
  });

  test("rounds run one after another and the phase follows the clock", () => {
    const rows: DrawingGameRows = {
      drawings: [1, 2].flatMap((turn) =>
        players.map((artistId, position) =>
          drawing({ id: turn * 100 + artistId, artistId, turn, position }),
        ),
      ),
      bluffs: [],
      votes: [],
    };
    const timeline = buildTimeline(START, rows);
    expect(
      timeline.filter((stage) => stage.kind === "draw").map((s) => s.turn),
    ).toEqual([1, 2]);
    const end = timeline.at(-1)!.endsAt;
    expect(drawingPhase(START, timeline, START - 1)).toBe("countdown");
    expect(drawingPhase(START, timeline, START)).toBe("racing");
    expect(drawingPhase(START, timeline, end - 1)).toBe("racing");
    expect(drawingPhase(START, timeline, end)).toBe("finished");
    expect(end - START).toBeLessThanOrEqual(worstCaseDurationMs(3, 2));
  });
});

describe("what each viewer is shown", () => {
  const START = 5_000_000;
  const settings = { packs: ["classics"], rounds: 1 };
  const rows: DrawingGameRows = {
    drawings: [1, 2, 3].map((artistId, position) =>
      drawing({
        id: artistId,
        artistId,
        position,
        prompt: `secret of ${artistId}`,
        strokes: [{ color: 0, brush: "thin", points: [1, 2, 3, 4] }],
        submittedAt: START + 100 * artistId,
      }),
    ),
    bluffs: [
      bluff({
        id: 1,
        drawingId: 1,
        authorId: 2,
        text: "bob's fib",
        createdAt: START + 1_000,
      }),
      bluff({
        id: 2,
        drawingId: 1,
        authorId: 3,
        text: "cat's fib",
        createdAt: START + 1_100,
      }),
    ],
    votes: [
      vote({ drawingId: 1, voterId: 2, createdAt: START + 2_000 }),
      vote({ drawingId: 1, voterId: 3, bluffId: 1, createdAt: START + 2_100 }),
    ],
  };
  const timeline = buildTimeline(START, rows);
  const view = (viewerId: number, now: number, finished = false) =>
    projectDrawingGame({ settings, rows, timeline, now, finished, viewerId });
  const at = (kind: string) =>
    timeline.find((s) => s.kind === kind && (s.drawingId ?? 1) === 1)!;

  test("while drawing, you see your own prompt and nobody else's anything", () => {
    const early = {
      ...rows,
      drawings: rows.drawings.map((d) => ({ ...d, submittedAt: null })),
    };
    const game = projectDrawingGame({
      settings,
      rows: early,
      timeline: buildTimeline(START, early),
      now: START + 10,
      finished: false,
      viewerId: 2,
    });
    expect(game.stage?.kind).toBe("draw");
    expect(game.myPrompt).toBe("secret of 2");
    const json = JSON.stringify(game);
    expect(json).not.toContain("secret of 1");
    expect(json).not.toContain("secret of 3");
    expect(
      game.drawings.every((d) => d.strokes === null || d.artistId === 2),
    ).toBe(true);
  });

  test("the ballot hides everything but the text until the reveal", () => {
    const game = view(2, at("vote").startedAt);
    expect(game.stage?.kind).toBe("vote");
    const spotlight = game.drawings.find((d) => d.id === 1)!;
    expect(spotlight.prompt).toBeNull();
    expect(spotlight.strokes).not.toBeNull();
    expect(
      spotlight.answers!.every(
        (a) => a.real === null && a.authorId === null && a.voterIds === null,
      ),
    ).toBe(true);
    expect(spotlight.answers!.find((a) => a.mine)!.text).toBe("bob's fib");
    // Not up yet: no strokes (though your own drawing is yours to see)...
    expect(game.drawings.find((d) => d.id === 3)!.strokes).toBeNull();
    expect(game.drawings.find((d) => d.id === 2)!.strokes).not.toBeNull();
    // ...and no prompt but your own anywhere; the spotlight's real title is
    // on the ballot, but only as one unmarked line among the bluffs.
    expect(JSON.stringify(game)).not.toContain("secret of 3");
  });

  test("a spectator is held to the same rules as a player", () => {
    const game = view(99, at("vote").startedAt);
    const json = JSON.stringify(game);
    expect(json).not.toMatch(/secret of [23]/);
    expect(game.myPrompt).toBeNull();
    // The truth is only ever a line on the ballot, never the prompt.
    expect(game.drawings.every((d) => d.prompt === null)).toBe(true);
  });

  test("the reveal shows the truth, who wrote what, who fell for it, and when to flip", () => {
    const reveal = at("reveal");
    const game = view(3, reveal.startedAt);
    const spotlight = game.drawings.find((d) => d.id === 1)!;
    expect(spotlight.prompt).toBe("secret of 1");
    const real = spotlight.answers!.find((a) => a.real)!;
    expect(real).toMatchObject({
      text: "secret of 1",
      voterIds: [2],
      points: 1000,
    });
    const fooled = spotlight.answers!.find((a) => a.authorId === 2)!;
    expect(fooled).toMatchObject({ voterIds: [3], points: 500 });
    expect(real.revealAt!).toBeGreaterThan(fooled.revealAt!);
    // The unpicked bluff gets no beat.
    expect(
      spotlight.answers!.find((a) => a.authorId === 3)!.revealAt,
    ).toBeNull();
    // The scoreboard waits for the reveal to finish playing.
    expect(game.scores.every((s) => s.score === 0)).toBe(true);
    const after = view(3, reveal.endsAt);
    expect(after.scores).toEqual([
      { userId: 2, score: 1500 },
      { userId: 1, score: 1000 },
      { userId: 3, score: 0 },
    ]);
    // The next drawing keeps its secret (the viewer drew the third one).
    expect(JSON.stringify(after)).not.toContain("secret of 2");
  });

  test("once it's over, everything is on the table", () => {
    const game = view(1, timeline.at(-1)!.endsAt, true);
    expect(game.stage).toBeNull();
    expect(game.drawings.map((d) => d.prompt)).toEqual([
      "secret of 1",
      "secret of 2",
      "secret of 3",
    ]);
  });
});
