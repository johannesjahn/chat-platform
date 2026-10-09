import type { CSSProperties } from "react";
import { Check, Lock } from "lucide-react";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  useSubmitVote,
  type DrawingEntry,
  type DrawingGame,
} from "@/lib/games/drawing";
import { DrawingView } from "./DrawingView";
import { castLabel, type Cast } from "@/lib/games/cast";
import { SubmissionProgress } from "./shared";

// Each card lands at its own slight angle, like a hand of cards tossed onto
// a table — deterministic per slot so a re-render doesn't reshuffle them.
const TILTS = [-5, 4, -3, 6, -6, 3, -4, 5];

// The vote stage: the truth and every bluff dealt out as cards, in an order
// that gives nothing away. Pick the one you think is real — not your own
// bluff, and not at all on your own drawing. Your pick lights up; the rest
// fade back.
export function VoteStage({
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
  const submit = useSubmitVote(lobbyId);
  const isArtist = drawing.artistId === meId;
  const playing = meId !== undefined && game.participantIds.includes(meId);
  const canVote = playing && !isArtist && drawing.myVote === null;
  const picked = drawing.myVote ?? (submit.isPending ? submit.variables : null);
  const answers = drawing.answers ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-1 text-center">
        <h3 className="text-xl font-bold tracking-tight">
          {isArtist
            ? "They're voting on your drawing"
            : canVote
              ? "Which one is the real title?"
              : playing
                ? "Vote locked in"
                : "The players are voting"}
        </h3>
        <p className="text-sm text-muted-foreground">
          {isArtist
            ? "Fingers crossed some of them — but not all — find it."
            : canVote
              ? "Find the truth for 1000 points."
              : "Waiting for the others…"}
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] lg:items-start">
        <DrawingView
          strokes={drawing.strokes}
          label={`${castLabel(cast, drawing.artistId)}'s drawing`}
          className="mx-auto max-w-md rotate-[-1deg] xl:max-w-xl"
        />
        <ul className="flex flex-col gap-2.5" aria-label="Answers">
          {answers.map((answer, index) => {
            const chosen = picked === answer.id;
            const locked = answer.mine || !canVote || submit.isPending;
            return (
              <li
                key={answer.id}
                style={
                  {
                    "--stagger-index": index,
                    "--deal-tilt": `${TILTS[index % TILTS.length]}deg`,
                  } as CSSProperties
                }
                className="motion-safe:animate-card-deal stagger-in"
              >
                <button
                  type="button"
                  disabled={locked}
                  aria-pressed={chosen}
                  onClick={() => submit.mutate(answer.id)}
                  className={cn(
                    "group relative flex min-h-16 w-full items-center gap-3 rounded-xl border bg-card/80 px-4 py-3 text-left text-sm font-medium shadow-sm backdrop-blur transition-all duration-300 ease-spring",
                    !locked &&
                      "hover:-translate-y-0.5 hover:rotate-[-0.5deg] hover:border-[var(--game-from)] hover:shadow-lg hover:shadow-[var(--game-glow)]",
                    chosen &&
                      "game-ring scale-[1.03] border-transparent bg-[color-mix(in_oklch,var(--game-from),transparent_85%)] shadow-lg shadow-[var(--game-glow)]",
                    picked !== null && !chosen && "opacity-45",
                    answer.mine &&
                      "cursor-not-allowed border-dashed opacity-60",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold tabular-nums transition-colors",
                      chosen
                        ? "game-gradient border-transparent text-white"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    {chosen ? (
                      <Check
                        className="size-4 motion-safe:animate-like-pop"
                        strokeWidth={3}
                      />
                    ) : (
                      String.fromCharCode(65 + index)
                    )}
                  </span>
                  <span className="min-w-0 flex-1 text-balance break-words">
                    {answer.text}
                  </span>
                  {answer.mine && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <Lock className="size-3" />
                      {isArtist ? "Real" : "Yours"}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {submit.error && (
        <p className="text-center text-sm text-destructive" role="alert">
          {errorMessage(submit.error)}
        </p>
      )}
      <div className="flex justify-center">
        <SubmissionProgress
          done={drawing.voteCount}
          total={game.participantIds.length - 1}
          label="votes in"
        />
      </div>
    </div>
  );
}
