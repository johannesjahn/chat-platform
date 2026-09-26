import { Crown } from "lucide-react";
import { ordinal } from "@/lib/games/lobby";
import { cn } from "@/lib/utils";

const METAL: Record<number, string> = {
  1: "var(--game-gold)",
  2: "var(--game-silver)",
  3: "var(--game-bronze)",
};

// A finishing place (or leaderboard rank) as a medal: gold/silver/bronze
// discs for the podium places — gold wearing a crown — and a plain numbered
// disc after that. Drops in the first time it appears.
export function PlaceBadge({
  place,
  size = "md",
  delayMs = 0,
  className,
}: {
  place: number;
  size?: "sm" | "md" | "lg";
  /** Holds the drop-in back, e.g. until a podium column has risen. */
  delayMs?: number;
  className?: string;
}) {
  const metal = METAL[place];
  return (
    <span
      title={ordinal(place)}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full font-bold tabular-nums motion-safe:animate-medal-drop",
        size === "sm" && "size-6 text-[11px]",
        size === "md" && "size-8 text-xs",
        size === "lg" && "size-11 text-sm",
        metal
          ? "text-background shadow-md"
          : "border border-border bg-muted text-muted-foreground",
        className,
      )}
      style={{
        animationDelay: `${delayMs}ms`,
        ...(metal && {
          background: `radial-gradient(circle at 30% 25%, white, ${metal} 45%, color-mix(in oklch, ${metal}, black 25%))`,
          boxShadow: `0 0 18px -4px ${metal}`,
        }),
      }}
    >
      {place === 1 && (
        <Crown
          aria-hidden
          className="absolute -top-2.5 size-3.5 fill-[var(--game-gold)] text-[var(--game-gold)] drop-shadow"
        />
      )}
      {place}
    </span>
  );
}
