import { Zap } from "lucide-react";
import { reactionHue, type LiveResult } from "@/lib/games/reflex";
import { cn } from "@/lib/utils";

// One round of one player, as a small tile: the time for a hit (tinted by
// how fast), or what went wrong. Pops in when it lands, and wears a bolt if
// it was the quickest hit of the round.
export function ResultPill({
  result,
  current = false,
  fastest = false,
  className,
}: {
  result: LiveResult | undefined;
  current?: boolean;
  fastest?: boolean;
  className?: string;
}) {
  if (!result) {
    return (
      <span
        className={cn(
          "h-7 rounded-md border border-dashed bg-muted/30",
          current
            ? "border-[var(--game-from)] motion-safe:animate-reflex-current"
            : "border-muted-foreground/30",
          className,
        )}
      />
    );
  }
  const hit = result.outcome === "hit" && result.reactionMs !== null;
  return (
    <span
      title={
        hit
          ? `${result.reactionMs} ms`
          : { early: "False start", miss: "Too slow", wrong: "Wrong" }[
              result.outcome as "early" | "miss" | "wrong"
            ]
      }
      className={cn(
        "relative flex h-7 min-w-0 items-center justify-center rounded-md text-[10px] font-bold tabular-nums motion-safe:animate-reflex-pop-in sm:text-xs",
        hit && "text-white",
        result.outcome === "early" &&
          "bg-[oklch(0.62_0.22_25/0.3)] text-[oklch(0.55_0.2_25)] dark:text-[oklch(0.72_0.2_25)]",
        (result.outcome === "miss" || result.outcome === "wrong") &&
          "bg-muted/70 text-muted-foreground",
        fastest && "ring-2 ring-[var(--game-gold)]",
        className,
      )}
      style={
        hit
          ? {
              background: `oklch(0.6 0.17 ${reactionHue(result.reactionMs!)})`,
            }
          : undefined
      }
    >
      {hit ? result.reactionMs : result.outcome === "early" ? "✕" : "—"}
      {fastest && (
        <Zap className="absolute -right-1 -top-1.5 size-3 fill-[var(--game-gold)] text-[var(--game-gold)]" />
      )}
    </span>
  );
}
