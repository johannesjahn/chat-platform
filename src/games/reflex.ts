// Reflex Rush — a reaction game of short rounds, each a different test of
// nerve (see ReflexRound in Api.ts for what the client draws):
//
//  - "go":     classic — wait for green, then hit it.
//  - "decoy":  the same, but fake signals flash first; hitting one is a
//              false start.
//  - "match":  a cue symbol is shown, then symbols flash one after another;
//              hit only when the cue's symbol comes up (go/no-go).
//  - "arrow":  an arrow appears; press its direction (choice reaction).
//  - "target": a target pops up somewhere in the arena; hit it (aim).
//
// Everything about a game is laid out in advance from one random seed —
// which kind each round is and exactly when every signal, decoy, and target
// appears — so the schedule is the same on every client and every replica,
// and every player in a lobby gets the same signal at the same instant (a
// duel, not parallel solo runs). The seed is stored in the lobby's
// `passage` column (never sent to clients; they get the schedule it
// expands to).
//
// Scoring happens here, server-side, from what the client reports per round
// — its measured reaction time, the arrow it pressed, where it hit. Like
// the typing race's error count, anything the server can't check can only
// ever *lower* a score (a reported false start); everything that raises one
// is checked against the schedule (the right arrow, a hit inside the
// target), and a reaction faster than a human can react counts as jumping
// the gun, exactly as it would on a sprint start line.

export const REFLEX_KINDS = [
  "go",
  "decoy",
  "match",
  "arrow",
  "target",
] as const;
export type ReflexKind = (typeof REFLEX_KINDS)[number];

export const REFLEX_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type ReflexDirection = (typeof REFLEX_DIRECTIONS)[number];

export const REFLEX_COUNTDOWN_MS = 4_000;
export const REFLEX_MAX_PLAYERS = 6;
export const REFLEX_ROUNDS = 8;

// Each round opens with a title card (nothing to react to yet — presses are
// ignored), then the armed wait before the signal, then the window to react
// in, then a beat showing everyone's result before the next round.
export const REFLEX_INTRO_MS = 1_200;
export const REFLEX_RESULT_MS = 1_600;
export const REFLEX_WINDOW_MS: Record<ReflexKind, number> = {
  go: 1_200,
  decoy: 1_200,
  match: 1_300,
  arrow: 1_500,
  target: 1_800,
};
// After the last round's window closes, finishes are still accepted for
// this long (a client submits the moment it closes; this is network slack).
export const REFLEX_SUBMIT_MS = 5_000;

// Faster than this after the signal isn't a reaction, it's a guess — the
// same threshold sprint starts use — and it counts as a false start.
export const ANTICIPATION_MS = 100;
export const FALSE_START_PENALTY = 200;
// Points for a hit fall off linearly with reaction time past a per-kind
// "par" (aiming at a target or telling left from right takes longer than
// seeing green), between these bounds.
export const MAX_ROUND_POINTS = 1_000;
export const MIN_ROUND_POINTS = 100;
const POINTS_PER_MS = 2;
const PAR_MS: Record<ReflexKind, number> = {
  go: 150,
  decoy: 150,
  match: 200,
  arrow: 250,
  target: 350,
};
// Every clean hit in a row adds this much to the next hit's points, up to
// the cap — a false start, a miss, or a wrong answer resets it.
export const COMBO_STEP = 0.1;
export const MAX_COMBO_STEPS = 5;

// Decoy flashes and match symbols. The client maps a decoy `variant` to a
// look (see REFLEX_DECOYS in web/src/lib/games/reflex.ts) and a symbol to
// an emoji (REFLEX_SYMBOLS) — both lists must stay these lengths.
export const REFLEX_DECOY_VARIANTS = 3;
export const REFLEX_SYMBOLS = 6;
// How long a decoy flash stays up.
export const REFLEX_DECOY_FLASH_MS = 450;

// Target geometry, in arena units: the arena is REFLEX_ARENA_ASPECT times
// as wide as it is tall, `x`/`y` are fractions of its width/height, and the
// radius is a fraction of its width.
export const REFLEX_ARENA_ASPECT = 16 / 10;
export const REFLEX_TARGET_RADIUS = 0.07;
// A hit the client drew inside the target still counts this much outside
// it, for rounding and a finger's width.
const TARGET_SLACK = 1.3;

export type ReflexCue = {
  // Offset from `startsAt`, like every time in a plan.
  readonly at: number;
  // A decoy's look, or a match round's symbol.
  readonly variant: number;
};

export type ReflexPlanRound = {
  readonly kind: ReflexKind;
  readonly armAt: number;
  readonly signalAt: number;
  readonly closeAt: number;
  // Decoy flashes ("decoy") or the wrong symbols ("match") before the
  // signal, in order.
  readonly cues: ReadonlyArray<ReflexCue>;
  // "match": the symbol to hit on.
  readonly symbol: number | null;
  // "arrow": the direction to press.
  readonly direction: ReflexDirection | null;
  // "target": its center.
  readonly target: { readonly x: number; readonly y: number } | null;
};

export type ReflexPlan = {
  readonly rounds: ReadonlyArray<ReflexPlanRound>;
  // Offset of the last round's window closing — finishes land after it.
  readonly closeAt: number;
  // Offset at which the game is over for anyone who never submitted.
  readonly endsAt: number;
};

// mulberry32 — tiny, fast, and deterministic across runtimes, which is all
// a schedule needs (the *seed* is what's secret and securely random).
const seededRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
};

const SEED_PREFIX = "reflex:";

export const reflexSeedToPassage = (seed: number) => `${SEED_PREFIX}${seed}`;

export const reflexSeedOf = (passage: string | null): number | null => {
  if (!passage?.startsWith(SEED_PREFIX)) return null;
  const seed = Number(passage.slice(SEED_PREFIX.length));
  return Number.isInteger(seed) ? seed : null;
};

// The order of round kinds: always a plain "go" first (everyone learns the
// rhythm), every kind at least once, and never the same kind twice in a
// row.
const kindOrder = (random: () => number): ReflexKind[] => {
  const pick = <T>(items: ReadonlyArray<T>) =>
    items[Math.floor(random() * items.length)]!;
  for (;;) {
    const order: ReflexKind[] = ["go"];
    while (order.length < REFLEX_ROUNDS) {
      order.push(pick(REFLEX_KINDS.filter((kind) => kind !== order.at(-1))));
    }
    if (REFLEX_KINDS.every((kind) => order.includes(kind))) return order;
  }
};

export const buildReflexPlan = (seed: number): ReflexPlan => {
  const random = seededRandom(seed);
  // A duration somewhere in [min, max] ms.
  const between = (min: number, max: number) =>
    Math.round(min + random() * (max - min));
  // A uniformly chosen whole number in [0, count).
  const choose = (count: number) => Math.floor(random() * count);
  const rounds: ReflexPlanRound[] = [];
  let at = 0;
  for (const kind of kindOrder(random)) {
    const armAt = at;
    const armed = armAt + REFLEX_INTRO_MS;
    const cues: ReflexCue[] = [];
    let signalAt: number;
    let symbol: number | null = null;
    let direction: ReflexDirection | null = null;
    let target: ReflexPlanRound["target"] = null;

    if (kind === "decoy") {
      // One or two fakes, spaced well apart, then the real thing — never so
      // soon after the last fake that the two blur together.
      let cueAt = armed + between(500, 1_100);
      const count = random() < 0.45 ? 2 : 1;
      for (let i = 0; i < count; i++) {
        cues.push({ at: cueAt, variant: choose(REFLEX_DECOY_VARIANTS) });
        cueAt += between(750, 1_200);
      }
      signalAt = cues.at(-1)!.at + between(700, 1_500);
    } else if (kind === "match") {
      symbol = choose(REFLEX_SYMBOLS);
      // Two to four wrong symbols (never the same twice running), then the
      // right one.
      const count = 2 + choose(3);
      let cueAt = armed + between(400, 800);
      let previous: number | null = null;
      for (let i = 0; i < count; i++) {
        const options = Array.from(
          { length: REFLEX_SYMBOLS },
          (_, variant) => variant,
        ).filter((variant) => variant !== symbol && variant !== previous);
        const variant = options[choose(options.length)]!;
        cues.push({ at: cueAt, variant });
        previous = variant;
        cueAt += between(600, 850);
      }
      signalAt = cueAt;
    } else {
      signalAt = armed + between(900, 3_000);
      if (kind === "arrow") {
        direction = REFLEX_DIRECTIONS[choose(REFLEX_DIRECTIONS.length)]!;
      } else if (kind === "target") {
        target = {
          x: between(120, 880) / 1_000,
          y: between(170, 830) / 1_000,
        };
      }
    }

    const closeAt = signalAt + REFLEX_WINDOW_MS[kind];
    rounds.push({
      kind,
      armAt,
      signalAt,
      closeAt,
      cues,
      symbol,
      direction,
      target,
    });
    at = closeAt + REFLEX_RESULT_MS;
  }
  const closeAt = rounds.at(-1)!.closeAt;
  return { rounds, closeAt, endsAt: closeAt + REFLEX_SUBMIT_MS };
};

// What a client reports for one round (see ReflexTap in Api.ts).
export type ReflexTap = {
  readonly early: boolean;
  readonly reactionMs: number | null;
  readonly direction: ReflexDirection | null;
  readonly x: number | null;
  readonly y: number | null;
};

export type ReflexOutcome = "hit" | "early" | "miss" | "wrong";

export type ReflexRoundResult = {
  readonly outcome: ReflexOutcome;
  readonly reactionMs: number | null;
  readonly points: number;
};

export const basePoints = (kind: ReflexKind, reactionMs: number) =>
  Math.max(
    MIN_ROUND_POINTS,
    Math.min(
      MAX_ROUND_POINTS,
      Math.round(
        MAX_ROUND_POINTS - POINTS_PER_MS * (reactionMs - PAR_MS[kind]),
      ),
    ),
  );

export const comboMultiplier = (streak: number) =>
  1 + COMBO_STEP * Math.min(streak, MAX_COMBO_STEPS);

const onTarget = (
  target: NonNullable<ReflexPlanRound["target"]>,
  x: number,
  y: number,
) => {
  const dx = x - target.x;
  const dy = (y - target.y) / REFLEX_ARENA_ASPECT;
  return Math.hypot(dx, dy) <= REFLEX_TARGET_RADIUS * TARGET_SLACK;
};

const outcomeOf = (round: ReflexPlanRound, tap: ReflexTap): ReflexOutcome => {
  if (tap.early) return "early";
  if (tap.reactionMs === null) return "miss";
  if (tap.reactionMs < ANTICIPATION_MS) return "early";
  if (tap.reactionMs > REFLEX_WINDOW_MS[round.kind]) return "miss";
  if (round.kind === "arrow" && tap.direction !== round.direction) {
    return "wrong";
  }
  if (
    round.kind === "target" &&
    (tap.x === null || tap.y === null || !onTarget(round.target!, tap.x, tap.y))
  ) {
    return "wrong";
  }
  return "hit";
};

const round1 = (value: number) => Math.round(value * 10) / 10;

// Scores a whole game's reported taps against its plan — one tap per round.
export const scoreReflex = (
  plan: ReflexPlan,
  taps: ReadonlyArray<ReflexTap>,
):
  | {
      readonly ok: true;
      readonly score: number;
      readonly accuracy: number;
      readonly rounds: ReadonlyArray<ReflexRoundResult>;
    }
  | { readonly ok: false; readonly reason: string } => {
  if (taps.length !== plan.rounds.length) {
    return { ok: false, reason: "Report every round exactly once" };
  }
  let streak = 0;
  const rounds = plan.rounds.map((round, index): ReflexRoundResult => {
    const tap = taps[index]!;
    const outcome = outcomeOf(round, tap);
    if (outcome !== "hit") {
      streak = 0;
      return {
        outcome,
        reactionMs: outcome === "early" ? null : tap.reactionMs,
        points: outcome === "early" ? -FALSE_START_PENALTY : 0,
      };
    }
    const points = Math.round(
      basePoints(round.kind, tap.reactionMs!) * comboMultiplier(streak),
    );
    streak++;
    return { outcome, reactionMs: Math.round(tap.reactionMs!), points };
  });
  const hits = rounds.filter((round) => round.outcome === "hit").length;
  return {
    ok: true,
    score: Math.max(
      0,
      rounds.reduce((sum, round) => sum + round.points, 0),
    ),
    accuracy: round1((hits / rounds.length) * 100),
    rounds,
  };
};
