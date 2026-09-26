import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// The standard container for a block of a game page (lobbies, leaderboard,
// the race itself): the app's glass card, lit in the game's colors, with an
// optional header row.
export function GamePanel({
  title,
  icon: Icon,
  actions,
  children,
  className,
  live = false,
}: {
  title?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Circles the border with the game's comet — for the panel that's "on". */
  live?: boolean;
}) {
  return (
    <section
      className={cn(
        "game-glow relative flex flex-col gap-4 rounded-2xl bg-card/70 p-5 backdrop-blur-md",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500",
        live && "game-ring",
        className,
      )}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-center gap-2">
          {Icon && <Icon className="size-4.5 text-[var(--game-from)]" />}
          {title && (
            <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          )}
          {actions && (
            <div className="ml-auto flex items-center gap-2">{actions}</div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
