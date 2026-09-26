import type { CSSProperties, ReactNode } from "react";
import { CountUp } from "@/components/reactbits/CountUp";
import { cn } from "@/lib/utils";

// One headline number (a WPM, an accuracy, a rank) with its label — the
// shared stat tile for result cards and "your standing" summaries. Numbers
// roll up to their value rather than appearing.
export function GameStat({
  label,
  value,
  display,
  unit,
  decimals = 0,
  emphasis = false,
  className,
  style,
}: {
  label: ReactNode;
  value: number | null;
  /** Shown instead of `value` when the number needs its own formatting. */
  display?: ReactNode;
  unit?: string;
  decimals?: number;
  /** The tile's number wears the game's color and glow. (Not the gradient
   * text: `background-clip: text` doesn't reach into CountUp's animated
   * child, which would render the number invisible.) */
  emphasis?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={style}
      className={cn(
        "flex flex-col gap-1 rounded-xl border border-border/60 bg-background/40 px-4 py-3",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-500 motion-safe:fill-mode-both stagger-in",
        className,
      )}
    >
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="flex items-baseline gap-1">
        <span
          className={cn(
            "text-2xl font-bold tabular-nums tracking-tight",
            emphasis &&
              "text-[var(--game-from)] drop-shadow-[0_0_12px_var(--game-glow)]",
          )}
        >
          {display !== undefined ? (
            display
          ) : value === null ? (
            "—"
          ) : decimals > 0 ? (
            value.toFixed(decimals)
          ) : (
            <CountUp value={Math.round(value)} />
          )}
        </span>
        {unit && value !== null && (
          <span className="text-xs text-muted-foreground">{unit}</span>
        )}
      </span>
    </div>
  );
}
