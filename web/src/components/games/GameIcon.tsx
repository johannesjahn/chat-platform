import { cn } from "@/lib/utils";
import type { GameDefinition } from "@/lib/games/registry";

const SIZES = {
  sm: "size-9 rounded-lg [&_svg]:size-4.5",
  md: "size-12 rounded-xl [&_svg]:size-6",
  lg: "size-16 rounded-2xl [&_svg]:size-8",
} as const;

// A game's glyph on a tile of its gradient, with a soft halo in its glow —
// the game's "logo" wherever it's shown.
export function GameIcon({
  game,
  size = "md",
  className,
}: {
  game: Pick<GameDefinition, "icon">;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const Icon = game.icon;
  return (
    <span
      className={cn(
        "game-gradient relative flex shrink-0 items-center justify-center text-white shadow-lg shadow-[var(--game-glow)]",
        SIZES[size],
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-0 rounded-[inherit] bg-gradient-to-b from-white/25 to-transparent"
      />
      <Icon className="relative drop-shadow motion-safe:animate-float" />
    </span>
  );
}
