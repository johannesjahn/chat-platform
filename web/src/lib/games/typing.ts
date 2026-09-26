import { useCallback, useEffect, useRef, useState } from "react";
import { sendGameProgress } from "./rooms";

// How far past a mistake the racer may keep typing before input stops
// registering — enough to notice the red, not enough to type a whole wrong
// sentence. The mistake has to be backspaced out before progress resumes.
export const MAX_ERROR_RUN = 6;

// Progress frames go out at most this often (the server's per-connection
// budget is well above it — see GAME_PROGRESS_MAX_PER_SECOND in
// src/RealtimeSocket.ts), plus once on every word boundary so an opponent's
// lane moves in word-sized steps even for a fast typist.
const PROGRESS_INTERVAL_MS = 150;

// Before this much of the race has elapsed a live WPM is mostly noise (one
// keystroke 50ms in "is" 240 WPM), so it reads 0 until then.
const MIN_WPM_SAMPLE_MS = 1_000;

// Standard WPM: five characters (spaces included) is one word.
export const wordsPerMinute = (chars: number, elapsedMs: number): number =>
  elapsedMs < MIN_WPM_SAMPLE_MS ? 0 : chars / 5 / (elapsedMs / 60_000);

// Length of the prefix of `typed` that matches `passage`.
export function correctPrefixLength(passage: string, typed: string): number {
  const max = Math.min(passage.length, typed.length);
  let i = 0;
  while (i < max && passage[i] === typed[i]) i++;
  return i;
}

export type TypingState = {
  readonly typed: string;
  // Wrong keystrokes so far — each one lowers accuracy even once fixed.
  readonly errors: number;
  // Characters correctly typed from the start — the race position.
  readonly correct: number;
  readonly done: boolean;
};

// The typing engine for one round: owns what's been typed, counts
// mistakes as they happen, and streams progress to the lobby. `onFinish`
// fires once, the moment the passage is typed exactly.
export function useTypingRace({
  lobbyId,
  passage,
  enabled,
  onFinish,
}: {
  lobbyId: number;
  passage: string;
  enabled: boolean;
  onFinish: (typed: string, errors: number) => void;
}) {
  const [state, setState] = useState<TypingState>({
    typed: "",
    errors: 0,
    correct: 0,
    done: false,
  });
  const lastSent = useRef({ at: 0, progress: -1 });
  const reportedFinish = useRef(false);
  const finishRef = useRef(onFinish);
  useEffect(() => {
    finishRef.current = onFinish;
  }, [onFinish]);

  const handleInput = useCallback(
    (next: string) => {
      if (!enabled) return;
      setState((prev) => {
        if (prev.done) return prev;
        // Line breaks never belong to a passage (a mobile keyboard's
        // "return" would otherwise count as a keystroke).
        let value = next.replace(/[\r\n]/g, "");
        // Cap how far a mistake can run on.
        const limit = Math.min(
          passage.length,
          correctPrefixLength(passage, value) + MAX_ERROR_RUN,
        );
        if (value.length > limit) value = value.slice(0, limit);

        // Count every newly typed character that doesn't match its slot.
        let errors = prev.errors;
        if (value.length > prev.typed.length) {
          for (let i = prev.typed.length; i < value.length; i++) {
            if (value[i] !== passage[i]) errors++;
          }
        }
        const correct = correctPrefixLength(passage, value);
        return {
          typed: value,
          errors,
          correct,
          done: value === passage,
        };
      });
    },
    [enabled, passage],
  );

  // Side effects of a state change: stream progress, and report the finish.
  useEffect(() => {
    if (!enabled && !state.done) return;
    const now = performance.now();
    const atWordBoundary =
      state.correct > 0 && passage[state.correct - 1] === " ";
    if (
      state.correct !== lastSent.current.progress &&
      (state.done ||
        atWordBoundary ||
        now - lastSent.current.at >= PROGRESS_INTERVAL_MS)
    ) {
      lastSent.current = { at: now, progress: state.correct };
      sendGameProgress(lobbyId, state.correct);
    }
    if (state.done && !reportedFinish.current) {
      reportedFinish.current = true;
      finishRef.current(state.typed, state.errors);
    }
  }, [state, enabled, lobbyId, passage]);

  // A trailing flush, so a typist who pauses just after a throttled
  // keystroke still has their exact position shown.
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      const correct = state.correct;
      if (correct !== lastSent.current.progress) {
        lastSent.current = { at: performance.now(), progress: correct };
        sendGameProgress(lobbyId, correct);
      }
    }, PROGRESS_INTERVAL_MS * 2);
    return () => clearInterval(timer);
  }, [enabled, lobbyId, state.correct]);

  return { state, handleInput };
}
