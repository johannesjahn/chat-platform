import { cn } from "@/lib/utils";

// How long "GO!" stays up once the race is live.
const GO_MS = 900;

// The pre-race countdown drawn over the race area: "Get ready" until the
// last three seconds, then each number slams in and shrinks away, then GO!
// bursts out with a shockwave ring. Driven entirely by `startsAt` against
// the (server-corrected) clock, so every racer sees the same beat.
export function CountdownOverlay({
  startsAt,
  now,
}: {
  startsAt: number;
  now: number;
}) {
  const remaining = startsAt - now;
  if (remaining <= -GO_MS) return null;

  const counting = remaining > 0;
  const number = Math.ceil(remaining / 1000);
  const label = !counting ? "GO!" : number > 3 ? null : String(number);

  return (
    <div
      aria-live="assertive"
      className={cn(
        "pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center rounded-2xl",
        counting && "bg-background/70 backdrop-blur-sm",
      )}
    >
      {label === null ? (
        <div className="flex flex-col items-center gap-2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95">
          <span className="text-sm font-semibold uppercase tracking-[0.3em] text-muted-foreground">
            Get ready
          </span>
          <span className="text-lg text-muted-foreground">
            Read ahead — typing unlocks at zero
          </span>
        </div>
      ) : (
        <div key={label} className="relative flex items-center justify-center">
          {!counting && (
            <span
              aria-hidden
              className="absolute size-40 rounded-full border-4 border-[var(--game-from)] motion-safe:animate-go-burst"
            />
          )}
          {/* The pop lives on this wrapper, not on the text: `game-text`
              already owns its element's `animation` (the gradient drift). */}
          <span
            className={cn(
              "inline-block",
              counting
                ? "motion-safe:animate-countdown-pop"
                : "motion-safe:animate-go-burst",
            )}
          >
            <span className="game-text text-8xl font-black tracking-tighter drop-shadow-[0_0_30px_var(--game-glow)] sm:text-9xl">
              {label}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
