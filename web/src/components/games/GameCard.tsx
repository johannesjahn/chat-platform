import type { CSSProperties, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Lock, Users } from "lucide-react";
import { Spotlight } from "@/components/reactbits/Spotlight";
import { cn } from "@/lib/utils";
import { gameThemeStyle, type GameDefinition } from "@/lib/games/registry";
import { GameIcon } from "./GameIcon";

// A game's tile in the arcade hub. Playable games lift, catch a pointer-
// tracking spotlight in their own glow, and circle their border with the
// game's comet; upcoming ones sit dimmed behind a "coming soon" lock. `live`
// is a slot for whatever activity summary the game wants to show.
export function GameCard({
  game,
  live,
  index = 0,
}: {
  game: GameDefinition;
  live?: ReactNode;
  index?: number;
}) {
  const playable = game.status === "live";
  const body = (
    <>
      <Spotlight color={game.theme.glow} />
      <div
        aria-hidden
        className="game-gradient pointer-events-none absolute -right-16 -top-16 size-48 rounded-full opacity-20 blur-3xl transition-opacity duration-500 group-hover:opacity-40"
      />
      <div className="relative z-20 flex items-start justify-between gap-3">
        <GameIcon game={game} size="md" />
        {playable ? (
          live
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/60 px-2.5 py-0.5 text-xs text-muted-foreground">
            <Lock className="size-3" />
            Coming soon
          </span>
        )}
      </div>
      <div className="relative z-20 flex flex-col gap-1.5">
        <h3 className="text-xl font-bold tracking-tight">
          <span className={cn(playable && "game-text")}>{game.name}</span>
        </h3>
        <p className="text-sm font-medium text-foreground/80">{game.tagline}</p>
        <p className="text-sm text-muted-foreground">{game.description}</p>
      </div>
      <div className="relative z-20 mt-auto flex items-center justify-between pt-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Users className="size-3.5" />
          {game.players}
        </span>
        {playable && (
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-foreground">
            Play now
            <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
          </span>
        )}
      </div>
    </>
  );

  const className = cn(
    "group relative flex min-h-64 flex-col gap-4 overflow-hidden rounded-2xl bg-card/70 p-6 backdrop-blur-md",
    "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-4 motion-safe:fill-mode-both motion-safe:duration-700 stagger-in",
    playable
      ? "game-glow game-ring card-lift transition-all duration-300 ease-smooth hover:shadow-[0_24px_60px_-20px_var(--game-glow)]"
      : "border border-border/60 opacity-70 saturate-50",
  );
  const style = {
    ...gameThemeStyle(game.theme),
    "--stagger-index": index,
  } as CSSProperties;

  if (!playable) {
    return (
      <div className={className} style={style} aria-disabled>
        {body}
      </div>
    );
  }
  return (
    <Link
      to="/games/$game"
      params={{ game: game.id }}
      className={className}
      style={style}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty(
          "--spot-x",
          `${event.clientX - rect.left}px`,
        );
        event.currentTarget.style.setProperty(
          "--spot-y",
          `${event.clientY - rect.top}px`,
        );
      }}
    >
      {body}
    </Link>
  );
}
