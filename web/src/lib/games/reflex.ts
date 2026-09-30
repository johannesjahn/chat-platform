import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchClient } from "@/lib/api";
import type { components } from "@/lib/api-types";
import { leaderboardQueryKey, primeLobby, serverNow, unwrap } from "./lobby";
import { sendGameProgress } from "./rooms";

export type ReflexRound = components["schemas"]["ReflexRound"];
export type ReflexKind = components["schemas"]["ReflexKind"];
export type ReflexDirection = components["schemas"]["ReflexDirection"];
export type ReflexOutcome = components["schemas"]["ReflexOutcome"];
export type ReflexTap = components["schemas"]["ReflexTap"];
export type ReflexRoundResult = components["schemas"]["ReflexRoundResult"];

// --- Mirrors of src/games/reflex.ts -----------------------------------------
// The server scores the game; these only let the arena show a round's
// points the instant it's played. Keep them in step with the server's.
export const ANTICIPATION_MS = 100;
export const FALSE_START_PENALTY = 200;
export const REFLEX_ARENA_ASPECT = 16 / 10;
export const REFLEX_TARGET_RADIUS = 0.07;
export const REFLEX_DECOY_FLASH_MS = 450;
const PAR_MS: Record<ReflexKind, number> = {
  go: 150,
  decoy: 150,
  match: 200,
  arrow: 250,
  target: 350,
};
export const basePoints = (kind: ReflexKind, reactionMs: number) =>
  Math.max(
    100,
    Math.min(1000, Math.round(1000 - 2 * (reactionMs - PAR_MS[kind]))),
  );
export const comboMultiplier = (streak: number) =>
  1 + 0.1 * Math.min(streak, 5);

// A match round's symbols, by the index the server deals — exactly
// REFLEX_SYMBOLS long, and never reordered (it would change every plan's
// meaning mid-deploy). Picked to be told apart at a glance.
export const REFLEX_SYMBOLS = ["🍉", "⭐", "🍄", "💎", "🔔", "🐸"] as const;

// A decoy flash's look, by `variant` — exactly REFLEX_DECOY_VARIANTS long.
// Each is built to *feel* like the signal for a split second.
export const REFLEX_DECOYS = [
  { label: "READY?", tone: "amber" },
  { label: "HOLD", tone: "blue" },
  { label: "GO!", tone: "red" },
] as const;

export const REFLEX_KIND_COPY: Record<
  ReflexKind,
  { readonly title: string; readonly instruction: string }
> = {
  go: {
    title: "Quick draw",
    instruction: "Hit it the instant it turns green",
  },
  decoy: {
    title: "Decoys",
    instruction: "Only green counts — don't fall for the fakes",
  },
  match: {
    title: "Snap",
    instruction: "Hit only when your symbol shows up",
  },
  arrow: {
    title: "Arrows",
    instruction: "Press the way the arrow points",
  },
  target: {
    title: "Bullseye",
    instruction: "Tap the target the moment it appears",
  },
};

// A reaction time, in words.
export function reactionRating(ms: number): string {
  if (ms < 180) return "Inhuman";
  if (ms < 230) return "Lightning";
  if (ms < 280) return "Blazing";
  if (ms < 340) return "Sharp";
  if (ms < 450) return "Solid";
  return "Sleepy";
}

// Hue for a reaction time: green when it's quick, through amber, to red
// when it's sluggish.
export function reactionHue(ms: number): number {
  const t = Math.max(0, Math.min(1, (ms - 180) / 420));
  return 150 - t * 125;
}

// --- Live results over the lobby socket -------------------------------------
//
// A round's result goes out as a `game_progress` frame the moment it's
// played, so every opponent's row fills in live. Progress is one number
// that only ever grows (see noteGameProgress), so a result packs into
// `(round + 1) * 1000 + code`: the round keeps it growing, the code says
// what happened — a hit's time at 2ms resolution, or one of the misses.
// Eight rounds stay under the server's MAX_GAME_PROGRESS (10 000). Only for
// show: the server scores what each player submits at the end.
const EARLY_CODE = 990;
const MISS_CODE = 991;
const WRONG_CODE = 992;

export type LiveResult = {
  readonly outcome: ReflexOutcome;
  readonly reactionMs: number | null;
};

export function encodeLiveResult(index: number, result: LiveResult): number {
  const code =
    result.outcome === "hit"
      ? Math.min(Math.round((result.reactionMs ?? 0) / 2), EARLY_CODE - 1)
      : result.outcome === "early"
        ? EARLY_CODE
        : result.outcome === "wrong"
          ? WRONG_CODE
          : MISS_CODE;
  return (index + 1) * 1000 + code;
}

export function decodeLiveResult(
  progress: number,
): { readonly index: number; readonly result: LiveResult } | null {
  const index = Math.floor(progress / 1000) - 1;
  if (index < 0) return null;
  const code = progress % 1000;
  const result: LiveResult =
    code === EARLY_CODE
      ? { outcome: "early", reactionMs: null }
      : code === MISS_CODE
        ? { outcome: "miss", reactionMs: null }
        : code === WRONG_CODE
          ? { outcome: "wrong", reactionMs: null }
          : { outcome: "hit", reactionMs: code * 2 };
  return { index, result };
}

// Points per round (and the total) for a run of results, the way the server
// scores them — for live standings before the server's word is in. Holes
// (rounds not played yet) score nothing and don't break a streak.
export function scoreResults(
  rounds: ReadonlyArray<ReflexRound>,
  results: ReadonlyArray<LiveResult | undefined>,
): { readonly points: ReadonlyArray<number | null>; readonly total: number } {
  let streak = 0;
  const points = rounds.map((round, index) => {
    const result = results[index];
    if (!result) return null;
    if (result.outcome !== "hit" || result.reactionMs === null) {
      streak = 0;
      return result.outcome === "early" ? -FALSE_START_PENALTY : 0;
    }
    const earned = Math.round(
      basePoints(round.kind, result.reactionMs) * comboMultiplier(streak),
    );
    streak++;
    return earned;
  });
  return {
    points,
    total: Math.max(
      0,
      points.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    ),
  };
}

// Clean hits in a row going into round `index`.
export function streakBefore(
  results: ReadonlyArray<LiveResult | undefined>,
  index: number,
): number {
  let streak = 0;
  for (let i = index - 1; i >= 0 && results[i]?.outcome === "hit"; i--) {
    streak++;
  }
  return streak;
}

// --- Where the game is ------------------------------------------------------

export type ReflexStage =
  // Before the first round (the lobby countdown).
  | "before"
  // The round's title card; presses are ignored.
  | "intro"
  // Armed: any press is a false start.
  | "wait"
  // The signal is up.
  | "signal"
  // The window closed; the round's results are showing.
  | "result"
  // The last round is over.
  | "done";

export type ReflexView = {
  readonly index: number;
  readonly stage: ReflexStage;
  // The decoy flash or wrong symbol on screen, as an index into the
  // round's cues; null when there is none.
  readonly cue: number | null;
};

// How long the final round's result shows before the arena says "done".
const FINAL_RESULT_MS = 1_600;

export function reflexViewAt(
  rounds: ReadonlyArray<ReflexRound>,
  introMs: number,
  now: number,
): ReflexView {
  let index = -1;
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (now >= rounds[i]!.armAt) {
      index = i;
      break;
    }
  }
  if (index < 0) return { index: 0, stage: "before", cue: null };
  const round = rounds[index]!;
  if (now < round.armAt + introMs) return { index, stage: "intro", cue: null };
  if (now < round.signalAt) {
    let cue: number | null = null;
    for (let i = round.cues.length - 1; i >= 0; i--) {
      const at = round.cues[i]!.at;
      if (now >= at) {
        // A decoy is a flash; a wrong symbol stays up until the next one.
        if (round.kind === "match" || now < at + REFLEX_DECOY_FLASH_MS) {
          cue = i;
        }
        break;
      }
    }
    return { index, stage: "wait", cue };
  }
  if (now < round.closeAt) return { index, stage: "signal", cue: null };
  if (index === rounds.length - 1 && now >= round.closeAt + FINAL_RESULT_MS) {
    return { index, stage: "done", cue: null };
  }
  return { index, stage: "result", cue: null };
}

// --- The engine -------------------------------------------------------------

// A press, from a key or a pointer. Pointer presses carry where they landed
// (fractions of the arena) or, from an arrow pad, a direction.
export type ReflexPress = {
  readonly source: "key" | "pointer";
  // `event.timeStamp` — the same clock as requestAnimationFrame's.
  readonly at: number;
  readonly direction?: ReflexDirection;
  readonly x?: number;
  readonly y?: number;
};

export type LocalRoundResult = LiveResult & {
  readonly points: number;
  readonly tap: ReflexTap;
  // Where the press landed in the arena, for the hit's burst.
  readonly x: number | null;
  readonly y: number | null;
};

const NO_TAP: ReflexTap = {
  early: false,
  reactionMs: null,
  direction: null,
  x: null,
  y: null,
};

const storageKey = (lobbyId: number, round: number) =>
  `reflex:${lobbyId}:${round}`;

function loadStored(key: string, length: number): LocalRoundResult[] {
  try {
    const raw = sessionStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length === length) {
      return parsed as LocalRoundResult[];
    }
  } catch {
    // Storage off or garbled — start clean.
  }
  return [];
}

// On a touch screen an Arrows round is answered by tapping the side of the
// arena the arrow points to — split along its diagonals into four zones.
export function directionAt(x: number, y: number): ReflexDirection {
  const dx = (x - 0.5) * REFLEX_ARENA_ASPECT;
  const dy = y - 0.5;
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "up" : "down";
}

const onTarget = (round: ReflexRound, x: number, y: number) => {
  if (!round.target) return false;
  const dx = x - round.target.x;
  const dy = (y - round.target.y) / REFLEX_ARENA_ASPECT;
  return Math.hypot(dx, dy) <= REFLEX_TARGET_RADIUS;
};

// Runs one player's game: follows the schedule frame by frame, judges
// every press against it, streams each result to the lobby, and hands the
// whole game over once the last round closes. `enabled` is false for a
// spectator (they get the same show, without the controls) and once
// submitted.
//
// Reaction times are measured on the high-resolution event clock: from the
// animation frame that put the signal on screen to the press's own
// `timeStamp` — not to when a handler got around to running.
export function useReflexEngine({
  lobbyId,
  lobbyRound,
  rounds,
  introMs,
  enabled,
  onComplete,
}: {
  lobbyId: number;
  lobbyRound: number;
  rounds: ReadonlyArray<ReflexRound>;
  introMs: number;
  enabled: boolean;
  onComplete: (taps: ReflexTap[]) => void;
}) {
  const key = storageKey(lobbyId, lobbyRound);
  const [view, setView] = useState<ReflexView>(() =>
    reflexViewAt(rounds, introMs, serverNow()),
  );
  const [results, setResults] = useState<ReadonlyArray<LocalRoundResult>>(() =>
    loadStored(key, rounds.length),
  );
  // Presses that missed the target — a ripple where they landed.
  const [whiffs, setWhiffs] = useState<
    ReadonlyArray<{ id: number; x: number; y: number }>
  >([]);

  const viewRef = useRef(view);
  const resultsRef = useRef(results);
  const signalShownAt = useRef(new Map<number, number>());
  const completed = useRef(false);
  const completeRef = useRef(onComplete);
  useEffect(() => {
    completeRef.current = onComplete;
  }, [onComplete]);

  // The frame loop: only commits when the view actually changes (a handful
  // of times a round), and commits synchronously so the signal is painted
  // in the very frame it's timed from. A slow timer backs it up, since a
  // hidden tab gets no frames at all — the game still has to reach its end
  // (and be submitted) if the player looked away.
  useEffect(() => {
    if (rounds.length === 0) return;
    const tick = (frameAt: number) => {
      const next = reflexViewAt(rounds, introMs, serverNow());
      const current = viewRef.current;
      if (
        next.index === current.index &&
        next.stage === current.stage &&
        next.cue === current.cue
      ) {
        return;
      }
      if (next.stage === "signal") {
        signalShownAt.current.set(next.index, frameAt);
      }
      viewRef.current = next;
      flushSync(() => setView(next));
    };
    let frame = 0;
    const onFrame = (frameAt: number) => {
      tick(frameAt);
      frame = requestAnimationFrame(onFrame);
    };
    frame = requestAnimationFrame(onFrame);
    const fallback = setInterval(() => tick(performance.now()), 500);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(fallback);
    };
  }, [rounds, introMs]);

  // `sync` commits at once (from a press, so the verdict lands in the next
  // frame); an effect can't flush synchronously and doesn't need to.
  const record = useCallback(
    (
      index: number,
      result: Omit<LocalRoundResult, "points">,
      sync: boolean,
    ) => {
      const previous = resultsRef.current;
      const streak = streakBefore(previous, index);
      const points =
        result.outcome === "hit"
          ? Math.round(
              basePoints(rounds[index]!.kind, result.reactionMs!) *
                comboMultiplier(streak),
            )
          : result.outcome === "early"
            ? -FALSE_START_PENALTY
            : 0;
      const next = [...previous];
      next[index] = { ...result, points };
      resultsRef.current = next;
      if (sync) flushSync(() => setResults(next));
      else setResults(next);
      sendGameProgress(lobbyId, encodeLiveResult(index, result));
      try {
        sessionStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Only a reload's convenience.
      }
    },
    [rounds, lobbyId, key],
  );

  const press = useCallback(
    (input: ReflexPress) => {
      if (!enabled) return;
      const { index, stage } = viewRef.current;
      const round = rounds[index];
      if (!round || resultsRef.current[index]) return;
      // Target rounds are aimed: a key can't hit one — or jump it.
      if (round.kind === "target" && input.source === "key") return;
      const x = input.x ?? null;
      const y = input.y ?? null;

      if (stage === "wait") {
        record(
          index,
          {
            outcome: "early",
            reactionMs: null,
            tap: { ...NO_TAP, early: true },
            x,
            y,
          },
          true,
        );
        return;
      }
      if (stage !== "signal") return;
      const shownAt = signalShownAt.current.get(index);
      if (shownAt === undefined) return;
      const reactionMs = Math.max(0, Math.round(input.at - shownAt));

      if (round.kind === "arrow" && !input.direction) return;
      if (round.kind === "target") {
        if (x === null || y === null) return;
        if (!onTarget(round, x, y)) {
          const id = input.at;
          setWhiffs((list) => [...list.slice(-4), { id, x, y }]);
          return;
        }
      }
      const tap: ReflexTap = {
        early: false,
        reactionMs,
        direction: input.direction ?? null,
        x: round.kind === "target" ? x : null,
        y: round.kind === "target" ? y : null,
      };
      const outcome: ReflexOutcome =
        reactionMs < ANTICIPATION_MS
          ? "early"
          : round.kind === "arrow" && input.direction !== round.direction
            ? "wrong"
            : "hit";
      record(
        index,
        {
          outcome,
          reactionMs: outcome === "early" ? null : reactionMs,
          tap: outcome === "early" ? { ...NO_TAP, early: true } : tap,
          x,
          y,
        },
        true,
      );
    },
    [enabled, rounds, record],
  );

  // A round that closed without a press is a miss — told to the lobby right
  // away so opponents' rows don't sit waiting.
  useEffect(() => {
    if (!enabled) return;
    if (view.stage !== "result" && view.stage !== "done") return;
    if (resultsRef.current[view.index]) return;
    record(
      view.index,
      { outcome: "miss", reactionMs: null, tap: NO_TAP, x: null, y: null },
      false,
    );
  }, [enabled, view, record]);

  // Once the last round's verdict has had its moment on stage, the whole
  // game goes to the server (a solo game ends the instant it lands).
  const last = rounds.length - 1;
  useEffect(() => {
    if (!enabled || completed.current || rounds.length === 0) return;
    if (view.index !== last || view.stage !== "done") return;
    completed.current = true;
    completeRef.current(
      rounds.map((_, i) => resultsRef.current[i]?.tap ?? NO_TAP),
    );
  }, [enabled, view, last, rounds]);

  return { view, results, whiffs, press };
}

// --- Submitting -------------------------------------------------------------

export function useFinishReflex(lobbyId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (taps: ReflexTap[]) => {
      const sentAt = Date.now();
      const lobby = primeLobby(
        queryClient,
        unwrap(
          await fetchClient.POST("/games/lobbies/{id}/reflex", {
            params: { path: { id: String(lobbyId) } },
            body: { taps },
          }),
        ),
        sentAt,
      );
      void queryClient.invalidateQueries({
        queryKey: leaderboardQueryKey("reflex"),
      });
      return lobby;
    },
  });
}
