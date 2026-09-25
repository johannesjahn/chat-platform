import { cn } from "@/lib/utils";
import type { GameLobbyPhase } from "@/lib/games/lobby";

const PHASES: Record<
  GameLobbyPhase,
  { label: string; dot: string; className: string; pulse: boolean }
> = {
  waiting: {
    label: "Waiting for players",
    dot: "bg-sky-400",
    className: "border-sky-400/30 bg-sky-400/10 text-sky-200",
    pulse: true,
  },
  countdown: {
    label: "Starting",
    dot: "bg-amber-400",
    className: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    pulse: true,
  },
  racing: {
    label: "Live",
    dot: "bg-rose-500",
    className: "border-rose-500/30 bg-rose-500/10 text-rose-200",
    pulse: true,
  },
  finished: {
    label: "Finished",
    dot: "bg-emerald-400",
    className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
    pulse: false,
  },
};

// A lobby's phase as a pill — the same four states, the same colors, in
// every game. Live phases get the presence-style ping on their dot.
export function PhaseBadge({
  phase,
  className,
  label,
}: {
  phase: GameLobbyPhase;
  className?: string;
  /** Overrides the default wording, e.g. "Racing" vs "Live". */
  label?: string;
}) {
  const config = PHASES[phase];
  return (
    <span
      key={phase}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90 motion-safe:duration-300",
        config.className,
        className,
      )}
    >
      <span className="relative flex size-2">
        {config.pulse && (
          <span
            className={cn(
              "absolute inset-0 rounded-full motion-safe:animate-presence-ping",
              config.dot,
            )}
          />
        )}
        <span className={cn("relative size-2 rounded-full", config.dot)} />
      </span>
      {label ?? config.label}
    </span>
  );
}
