import { useState, type FormEvent } from "react";
import { Check, Drama, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  MAX_BLUFF_LENGTH,
  useSubmitBluff,
  type DrawingEntry,
  type DrawingGame,
} from "@/lib/games/drawing";
import { DrawingView } from "./DrawingView";
import { castLabel, type Cast } from "@/lib/games/cast";
import { SubmissionProgress, WaitingPencil } from "./shared";

// How long the drawing takes to redraw itself as it enters the spotlight.
const REPLAY_MS = 2_600;

// The bluff stage: one drawing in the spotlight, redrawing itself stroke by
// stroke, and everyone but its artist inventing a title for it that others
// will fall for. The server turns away one that's too close to the truth
// (or a copy of someone else's) — the field shakes and says so.
export function BluffStage({
  lobbyId,
  game,
  drawing,
  cast,
  meId,
}: {
  lobbyId: number;
  game: DrawingGame;
  drawing: DrawingEntry;
  cast: Cast;
  meId: number | undefined;
}) {
  const isArtist = drawing.artistId === meId;
  const playing = meId !== undefined && game.participantIds.includes(meId);
  const guessers = game.participantIds.length - 1;
  const submit = useSubmitBluff(lobbyId);
  const [text, setText] = useState("");
  // Bumped per rejection so the same message twice still shakes again.
  const [rejections, setRejections] = useState(0);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    submit.mutate(trimmed, {
      onError: () => setRejections((n) => n + 1),
    });
  };

  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] md:items-center">
      <figure className="flex flex-col gap-2">
        <DrawingView
          key={drawing.id}
          strokes={drawing.strokes}
          replayMs={REPLAY_MS}
          label={`${castLabel(cast, drawing.artistId)}'s drawing`}
          className="rotate-[-1deg] transition-transform duration-500 hover:rotate-0"
        />
        <figcaption className="text-center text-xs text-muted-foreground">
          {isArtist
            ? "Your drawing"
            : `By ${castLabel(cast, drawing.artistId)}`}
        </figcaption>
      </figure>

      <div className="flex flex-col gap-4">
        {isArtist ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-border/60 bg-background/50 p-5 text-center">
            <Drama className="size-8 text-[var(--game-from)] motion-safe:animate-doodle-wobble" />
            <p className="text-base font-semibold">This one&apos;s yours!</p>
            <p className="text-sm text-muted-foreground">
              Everyone is inventing fake titles for it. The real one was
            </p>
            <p className="text-lg font-bold">
              <span className="game-text">{drawing.prompt}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              You score for every player who finds it — as long as not all of
              them do.
            </p>
          </div>
        ) : !playing ? (
          <WaitingPencil>The players are inventing fake titles.</WaitingPencil>
        ) : drawing.myBluff !== null ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-border/60 bg-background/50 p-5 text-center motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95">
            <span className="flex size-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400 motion-safe:animate-badge-pop">
              <Check
                className="size-5 motion-safe:animate-check-draw"
                strokeWidth={3}
              />
            </span>
            <p className="text-sm text-muted-foreground">Your bluff is in</p>
            <p className="text-balance text-lg font-semibold">
              &ldquo;{drawing.myBluff}&rdquo;
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label htmlFor="bluff" className="flex flex-col gap-1">
              <span className="text-base font-semibold">What is this?</span>
              <span className="text-sm text-muted-foreground">
                Write a title the others will believe is the real prompt. Each
                player who picks yours earns you 500.
              </span>
            </label>
            <div
              key={rejections}
              className={cn(
                "relative",
                rejections > 0 && "motion-safe:animate-shake",
              )}
            >
              <Input
                id="bluff"
                autoFocus
                autoComplete="off"
                value={text}
                maxLength={MAX_BLUFF_LENGTH}
                placeholder="a very convincing lie"
                onChange={(event) => setText(event.target.value)}
                aria-invalid={!!submit.error}
                aria-describedby="bluff-count bluff-error"
                className="h-11 pr-14 text-base"
              />
              <span
                id="bluff-count"
                className={cn(
                  "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs tabular-nums text-muted-foreground",
                  text.length >= MAX_BLUFF_LENGTH - 5 && "text-amber-400",
                )}
              >
                {MAX_BLUFF_LENGTH - text.length}
              </span>
            </div>
            {submit.error && (
              <p
                id="bluff-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {errorMessage(submit.error)}
              </p>
            )}
            <Button
              type="submit"
              disabled={submit.isPending || text.trim().length === 0}
              className="game-gradient border-0 text-white shadow-lg shadow-[var(--game-glow)] hover:opacity-95"
            >
              <Send className="size-4" />
              Submit bluff
            </Button>
          </form>
        )}
        <SubmissionProgress
          done={drawing.bluffCount}
          total={guessers}
          label="bluffs in"
        />
      </div>
    </div>
  );
}
