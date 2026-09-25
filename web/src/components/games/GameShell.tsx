import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { gameThemeStyle, type GameDefinition } from "@/lib/games/registry";
import { GameIcon } from "./GameIcon";

type GameShellProps = {
  game: GameDefinition;
  /** Defaults to the game's name. */
  title?: ReactNode;
  /** Defaults to the game's tagline. */
  subtitle?: ReactNode;
  /** A back link — to the game's own page when `game` is given, else to the
   * arcade. Omit for none. */
  back?: { label: string; game?: string };
  /** Buttons etc. aligned to the header's right edge. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
};

// The frame every game page sits in: themes everything inside it with the
// game's colors (see `gameThemeStyle`), and gives it the same hero header —
// drifting arcade grid, gradient icon tile, gradient headline — so every
// game in the arcade reads as part of one family.
export function GameShell({
  game,
  title,
  subtitle,
  back,
  actions,
  children,
  className,
}: GameShellProps) {
  return (
    <main
      style={gameThemeStyle(game.theme)}
      className={cn(
        "relative mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pb-16 pt-6",
        className,
      )}
    >
      <div
        aria-hidden
        className="game-grid pointer-events-none absolute inset-x-0 top-0 -z-10 h-72 opacity-70"
      />
      <header className="flex flex-col gap-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2 motion-safe:duration-500">
        {back && (
          <Link
            {...(back.game
              ? { to: "/games/$game", params: { game: back.game } }
              : { to: "/games" })}
            className="group inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4 transition-transform duration-300 group-hover:-translate-x-0.5" />
            {back.label}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <GameIcon game={game} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="break-words text-2xl font-bold tracking-tight sm:text-4xl">
              <span className="game-text">{title ?? game.name}</span>
            </h1>
            <p className="text-sm text-muted-foreground sm:text-base">
              {subtitle ?? game.tagline}
            </p>
          </div>
          {actions && (
            // Its own row on a phone, so the headline keeps the width.
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              {actions}
            </div>
          )}
        </div>
      </header>
      {children}
    </main>
  );
}
