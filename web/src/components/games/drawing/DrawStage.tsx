import { useEffect, useRef, useState } from "react";
import { Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import {
  useSubmitDrawing,
  type DrawingGame,
  type DrawingStage,
  type DrawingStroke,
} from "@/lib/games/drawing";
import { DrawingView } from "./DrawingView";
import type { Cast } from "@/lib/games/cast";
import { DrawRoster, WaitingPencil } from "./shared";
import { SketchCanvas } from "./SketchCanvas";

// Submit this long before the timer runs out, so the drawing lands inside
// the stage (the server allows a little grace after it, too).
const AUTO_SUBMIT_LEAD_MS = 400;

// An unfinished drawing survives a reload mid-round: it's kept per lobby,
// game, and round in sessionStorage until it's submitted.
const draftKey = (lobbyId: number, round: number, turn: number) =>
  `sketchy-draft:${lobbyId}:${round}:${turn}`;

function loadDraft(key: string): DrawingStroke[] {
  try {
    const raw = sessionStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as DrawingStroke[]) : [];
  } catch {
    return [];
  }
}

function saveDraft(key: string, strokes: DrawingStroke[] | null): void {
  try {
    if (strokes === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(strokes));
  } catch {
    // Private mode, quota — the draft just won't survive a reload.
  }
}

// The draw stage: your secret prompt unfolds, you draw it, and it's sent
// either when you say you're done or, as-is, when time runs out. Everyone
// else's progress shows as a roster of avatars checking in.
export function DrawStage({
  lobbyId,
  lobbyRound,
  game,
  stage,
  cast,
  meId,
  now,
}: {
  lobbyId: number;
  lobbyRound: number;
  game: DrawingGame;
  stage: DrawingStage;
  cast: Cast;
  meId: number | undefined;
  now: number;
}) {
  const round = game.drawings.filter((d) => d.turn === stage.turn);
  const mine = round.find((d) => d.artistId === meId);
  const key = draftKey(lobbyId, lobbyRound, stage.turn);
  const [strokes, setStrokes] = useState<DrawingStroke[]>(() => loadDraft(key));
  const submit = useSubmitDrawing(lobbyId);
  const { mutate, isPending, isSuccess } = submit;

  const onChange = (next: DrawingStroke[]) => {
    setStrokes(next);
    saveDraft(key, next);
  };

  const send = () => mutate(strokes, { onSuccess: () => saveDraft(key, null) });

  // Time's up: send whatever is on the canvas. Once only — a failed send
  // isn't retried on every tick.
  const autoSent = useRef(false);
  const due =
    !!mine && !mine.submitted && now >= stage.endsAt - AUTO_SUBMIT_LEAD_MS;
  useEffect(() => {
    if (!due || autoSent.current || isPending) return;
    autoSent.current = true;
    mutate(strokes, { onSuccess: () => saveDraft(key, null) });
  }, [due, isPending, mutate, strokes, key]);

  const done = mine?.submitted || isSuccess;

  return (
    <div className="flex flex-col gap-5">
      {mine && game.myPrompt && (
        <div
          key={game.myPrompt}
          className="relative flex flex-col items-center gap-1 overflow-hidden rounded-2xl border border-[color-mix(in_oklch,var(--game-from),transparent_55%)] bg-background/60 px-5 py-4 text-center motion-safe:animate-prompt-unfold"
        >
          <span
            aria-hidden
            className="game-gradient pointer-events-none absolute -top-12 left-1/2 size-40 -translate-x-1/2 rounded-full opacity-25 blur-3xl"
          />
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">
            <Sparkles className="size-3.5 text-[var(--game-from)]" />
            Your secret prompt
          </span>
          <span
            data-prompt
            className="text-balance text-2xl font-black tracking-tight sm:text-3xl"
          >
            <span className="game-text">{game.myPrompt}</span>
          </span>
          <span className="text-xs text-muted-foreground">
            Don&apos;t write it out — others have to guess it from the picture.
          </span>
        </div>
      )}

      {mine && !done && (
        <>
          <SketchCanvas
            strokes={strokes}
            onChange={onChange}
            disabled={isPending}
          />
          <div className="flex flex-col items-center gap-2">
            <Button
              size="lg"
              disabled={isPending}
              onClick={send}
              className="game-gradient min-w-48 border-0 text-white shadow-lg shadow-[var(--game-glow)] hover:opacity-95"
            >
              <Send className="size-4" />
              {strokes.length === 0 ? "Submit a blank canvas" : "I'm done"}
            </Button>
            {submit.error && (
              <p className="text-sm text-destructive" role="alert">
                {errorMessage(submit.error)}
              </p>
            )}
          </div>
        </>
      )}

      {mine && done && (
        <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-500">
          <DrawingView
            strokes={mine.strokes ?? strokes}
            label="Your drawing"
            className="rotate-[-1.5deg]"
          />
          <p className="text-sm font-medium">Sent! Nice work.</p>
        </div>
      )}

      {!mine && (
        <WaitingPencil>
          Everyone is drawing their secret prompt. You&apos;ll see the drawings
          in a moment.
        </WaitingPencil>
      )}

      <div className="flex flex-col items-center gap-2">
        {done && <WaitingPencil>Waiting for the other artists</WaitingPencil>}
        <DrawRoster cast={cast} artists={round} />
      </div>
    </div>
  );
}
