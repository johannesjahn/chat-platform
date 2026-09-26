import type { CSSProperties } from "react";
import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";
import { userAvatarName, userLabel } from "@/lib/users";
import type { GameLobbyPlayer } from "@/lib/games/lobby";
import { formatDuration } from "@/lib/games/lobby";
import { PlaceBadge } from "./PlaceBadge";

// Column heights and the order they rise in: third, then second, then the
// winner last — the reveal saves the best for the end.
const PODIUM = [
  { place: 2, height: "h-24", delay: 250 },
  { place: 1, height: "h-32", delay: 500 },
  { place: 3, height: "h-16", delay: 0 },
] as const;

// A race's results: the top three stand on a podium that grows up out of the
// floor, medals dropping onto them; everyone else — and anyone who didn't
// finish — lines up underneath. Game-agnostic: it shows each player's
// `score` in the game's unit.
export function ResultsPodium({
  players,
  scoreUnit,
  meId,
}: {
  players: ReadonlyArray<GameLobbyPlayer>;
  scoreUnit: string;
  meId: number | undefined;
}) {
  const finishers = players
    .filter((player) => player.place !== null)
    .sort((a, b) => a.place! - b.place!);
  const dnf = players.filter((player) => player.place === null);
  const byPlace = new Map(finishers.map((p) => [p.place!, p]));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-center gap-2 pt-6 sm:gap-4">
        {PODIUM.map(({ place, height, delay }) => {
          // Ties can put two players on one place; the podium shows the
          // first, the list below shows everyone.
          const player = byPlace.get(place);
          return (
            <div
              key={place}
              className="flex w-24 flex-col items-center gap-2 sm:w-32"
            >
              {player ? (
                <div
                  className="flex flex-col items-center gap-1 text-center motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-4 motion-safe:fill-mode-both motion-safe:duration-500"
                  style={{ animationDelay: `${delay + 500}ms` }}
                >
                  <div className="relative">
                    <Avatar
                      name={userAvatarName(player.user)}
                      avatarUrl={player.user.avatarUrl}
                      avatarVariants={player.user.avatarVariants}
                      size={place === 1 ? "lg" : "md"}
                      className={cn(
                        "ring-2 ring-offset-2 ring-offset-background",
                        place === 1 && "ring-[var(--game-gold)]",
                        place === 2 && "ring-[var(--game-silver)]",
                        place === 3 && "ring-[var(--game-bronze)]",
                      )}
                    />
                  </div>
                  <span
                    className={cn(
                      "max-w-full truncate text-sm font-semibold",
                      player.user.id === meId && "text-[var(--game-from)]",
                    )}
                  >
                    {userLabel(player.user)}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    <span className="text-base font-bold text-foreground">
                      {Math.round(player.score ?? 0)}
                    </span>{" "}
                    {scoreUnit}
                  </span>
                </div>
              ) : (
                <div className="h-16" />
              )}
              <div
                className={cn(
                  "relative flex w-full items-start justify-center rounded-t-xl border border-b-0 pt-3 motion-safe:animate-podium-rise",
                  height,
                  place === 1
                    ? "game-gradient border-transparent shadow-[0_-10px_40px_-10px_var(--game-glow)]"
                    : "border-border/60 bg-card/80",
                )}
                style={{ animationDelay: `${delay}ms` }}
              >
                <PlaceBadge place={place} size="lg" delayMs={delay + 450} />
              </div>
            </div>
          );
        })}
      </div>

      {players.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {[...finishers, ...dnf].map((player, index) => (
            <li
              key={player.user.id}
              style={{ "--stagger-index": index } as CSSProperties}
              className={cn(
                "flex items-center gap-3 rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-sm",
                "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:fill-mode-both stagger-in",
                player.user.id === meId && "game-ring border-transparent",
              )}
            >
              {player.place !== null ? (
                <PlaceBadge place={player.place} size="sm" />
              ) : (
                <span className="flex size-6 items-center justify-center text-[10px] font-semibold text-muted-foreground">
                  DNF
                </span>
              )}
              <Avatar
                name={userAvatarName(player.user)}
                avatarUrl={player.user.avatarUrl}
                avatarVariants={player.user.avatarVariants}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate font-medium">
                {userLabel(player.user)}
              </span>
              {player.score !== null ? (
                <span className="flex items-center gap-3 tabular-nums text-muted-foreground">
                  <span>
                    <span className="font-bold text-foreground">
                      {Math.round(player.score)}
                    </span>{" "}
                    {scoreUnit}
                  </span>
                  <span className="hidden sm:inline">
                    {player.accuracy?.toFixed(1)}%
                  </span>
                  <span className="hidden sm:inline">
                    {formatDuration(player.durationMs ?? 0)}
                  </span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Didn&apos;t finish
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
