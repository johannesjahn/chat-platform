import type { CSSProperties } from "react";
import { Crown, Ghost } from "lucide-react";
import { Confetti } from "@/components/games/Confetti";
import { cn } from "@/lib/utils";
import type { DrawingAnswer, DrawingEntry } from "@/lib/games/drawing";
import { DrawingView } from "./DrawingView";
import { castLabel, type Cast } from "@/lib/games/cast";
import { CastAvatar } from "./shared";

// A flip only gets the viewer's own celebration while it's fresh — not when
// the page is reloaded halfway through the reveal.
const CELEBRATE_WINDOW_MS = 4_000;
// Voter avatars hop onto a card one after another, starting a beat after it
// turns over.
const HOP_DELAY_MS = 380;
const HOP_STAGGER_MS = 110;

// The reveal: every bluff that fooled somebody turns over in turn (the
// least popular first), each showing who wrote it and who fell for it, and
// then the truth lands last. The whole sequence runs off the server's
// timestamps (`revealAt`), so everyone sees the same card flip at the same
// moment, and a page reloaded mid-reveal picks up exactly where it was.
export function RevealStage({
  drawing,
  cast,
  meId,
  now,
}: {
  drawing: DrawingEntry;
  cast: Cast;
  meId: number | undefined;
  now: number;
}) {
  const answers = drawing.answers ?? [];
  const sequence = answers
    .filter((answer) => answer.revealAt !== null)
    .sort((a, b) => a.revealAt! - b.revealAt!);
  const unpicked = answers.filter((answer) => answer.revealAt === null);
  const flipped = sequence.filter((answer) => now >= answer.revealAt!);
  const latest = flipped.at(-1);
  const truth = answers.find((answer) => answer.real);
  const truthOut = !!truth && flipped.includes(truth);

  // Something to cheer for the viewer: they found the truth, or their bluff
  // just fooled someone.
  const cheer =
    latest &&
    now - latest.revealAt! < CELEBRATE_WINDOW_MS &&
    meId !== undefined &&
    (latest.real
      ? latest.voterIds!.includes(meId)
      : latest.authorId === meId && latest.voterIds!.length > 0);

  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] md:items-start">
      {cheer && <Confetti key={latest.id} pieces={60} />}
      <figure className="flex flex-col gap-2 md:sticky md:top-20">
        <DrawingView
          strokes={drawing.strokes}
          label={`${castLabel(cast, drawing.artistId)}'s drawing`}
          className="rotate-[-1deg]"
        >
          {truthOut && (
            <div className="absolute inset-x-3 bottom-3 rounded-lg bg-black/70 px-3 py-2 text-center text-sm font-semibold text-white backdrop-blur motion-safe:animate-in motion-safe:slide-in-from-bottom-3 motion-safe:fade-in-0 motion-safe:duration-500">
              {drawing.prompt}
            </div>
          )}
        </DrawingView>
        <figcaption className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <CastAvatar cast={cast} userId={drawing.artistId} size="sm" />
          Drawn by {castLabel(cast, drawing.artistId)}
        </figcaption>
      </figure>

      <div className="flex flex-col gap-3">
        {flipped.length === 0 && (
          <p className="py-2 text-center text-sm font-medium text-muted-foreground motion-safe:animate-pulse">
            Let&apos;s see who fooled whom…
          </p>
        )}
        <ol className="flex flex-col gap-2.5" aria-label="Reveal">
          {sequence.map((answer) => (
            <RevealCard
              key={answer.id}
              answer={answer}
              cast={cast}
              artistId={drawing.artistId}
              meId={meId}
              shown={now >= answer.revealAt!}
              current={answer === latest}
            />
          ))}
        </ol>
        {truthOut && unpicked.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border/70 p-3 text-xs text-muted-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-700">
            <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wider">
              <Ghost className="size-3.5" />
              Nobody fell for
            </span>
            <ul className="flex flex-col gap-1">
              {unpicked.map((answer) => (
                <li key={answer.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    &ldquo;{answer.text}&rdquo;
                  </span>
                  <span className="shrink-0">
                    {answer.authorId !== null &&
                      castLabel(cast, answer.authorId)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function RevealCard({
  answer,
  cast,
  artistId,
  meId,
  shown,
  current,
}: {
  answer: DrawingAnswer;
  cast: Cast;
  artistId: number;
  meId: number | undefined;
  shown: boolean;
  current: boolean;
}) {
  if (!shown) {
    // Face down: the text is no secret by now (it was on the ballot) — the
    // verdict is.
    return (
      <li className="flex min-h-14 items-center gap-3 rounded-xl border border-border/50 bg-background/30 px-4 py-3 text-sm text-muted-foreground opacity-70">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-xs font-bold">
          ?
        </span>
        <span className="min-w-0 flex-1 truncate">{answer.text}</span>
      </li>
    );
  }

  const voters = answer.voterIds ?? [];
  const real = answer.real === true;
  const earner = real ? artistId : answer.authorId;
  const points = answer.points ?? 0;

  return (
    <li
      className={cn(
        "relative flex flex-col gap-2.5 overflow-hidden rounded-xl border px-4 py-3 transition-transform duration-500 ease-spring motion-safe:animate-card-flip",
        real
          ? "border-transparent bg-[color-mix(in_oklch,var(--game-from),transparent_86%)] motion-safe:animate-truth-glow"
          : "border-rose-500/30 bg-rose-500/[0.06]",
        current && "scale-[1.02]",
        earner === meId && "ring-1 ring-[var(--game-from)]",
      )}
    >
      <span
        style={
          {
            "--stamp-tilt": real ? "-8deg" : "10deg",
            animationDelay: "250ms",
          } as CSSProperties
        }
        className={cn(
          "absolute right-3 top-2.5 rounded-md border-2 px-2 py-0.5 text-[11px] font-black uppercase tracking-[0.2em] motion-safe:animate-stamp",
          real
            ? "border-emerald-400 text-emerald-400"
            : "border-rose-400 text-rose-400",
        )}
      >
        {real ? "Truth" : "Fake"}
      </span>

      <p className="pr-20 text-balance text-base font-semibold leading-snug">
        {real ? <span className="game-text">{answer.text}</span> : answer.text}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        {real ? (
          <span className="inline-flex items-center gap-1.5">
            <Crown className="size-3.5 text-[var(--game-gold)]" />
            The real prompt
          </span>
        ) : (
          answer.authorId !== null && (
            <span className="inline-flex items-center gap-1.5">
              <CastAvatar cast={cast} userId={answer.authorId} size="sm" />
              {answer.authorId === meId
                ? "Your bluff"
                : `${castLabel(cast, answer.authorId)}'s bluff`}
            </span>
          )
        )}

        {voters.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            {real ? "Found by" : "Fooled"}
            <span className="flex -space-x-1.5">
              {voters.map((voterId, index) => (
                <CastAvatar
                  key={voterId}
                  cast={cast}
                  userId={voterId}
                  size="sm"
                  className="rounded-full ring-2 ring-card motion-safe:animate-avatar-hop"
                  style={{
                    animationDelay: `${HOP_DELAY_MS + index * HOP_STAGGER_MS}ms`,
                  }}
                />
              ))}
            </span>
          </span>
        )}

        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-xs font-bold tabular-nums motion-safe:animate-points-float",
            points > 0
              ? "game-gradient text-white shadow-md shadow-[var(--game-glow)]"
              : "bg-muted text-muted-foreground",
          )}
          style={{
            animationDelay: `${HOP_DELAY_MS + voters.length * HOP_STAGGER_MS + 150}ms`,
          }}
        >
          {points > 0
            ? `+${points} ${earner === meId ? "to you" : `to ${castLabel(cast, earner!)}`}`
            : real
              ? voters.length === 0
                ? "Nobody found it — no points"
                : "Everyone found it — too easy!"
              : "+0"}
        </span>
      </div>
    </li>
  );
}
