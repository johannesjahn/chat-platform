import type { CSSProperties } from "react";
import type { GameLobby } from "@/lib/games/lobby";
import { useFlyingReactions } from "@/lib/games/reactions";
import { userLabel } from "@/lib/users";

// Reactions flung in this lobby, floating up the right-hand side of the
// screen over whatever is going on. Purely decorative — screen readers skip
// it — and never in the way of a click.
export function ReactionStream({
  lobby,
  meId,
}: {
  lobby: GameLobby;
  meId: number | undefined;
}) {
  const flying = useFlyingReactions().filter((f) => f.lobbyId === lobby.id);
  if (flying.length === 0) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-y-0 right-0 z-40 w-40 overflow-hidden sm:w-56"
    >
      {flying.map((f) => {
        const player = lobby.players.find((p) => p.user.id === f.userId);
        const name =
          f.userId === meId ? "You" : player ? userLabel(player.user) : null;
        return (
          <span
            key={f.key}
            style={
              {
                left: `${10 + f.x * 70}%`,
                "--reaction-drift": f.drift,
              } as CSSProperties
            }
            className="absolute bottom-6 flex flex-col items-center gap-0.5 animate-reaction-float"
          >
            <span className="text-4xl drop-shadow-[0_4px_12px_var(--game-glow)]">
              {f.reaction}
            </span>
            {name && (
              <span className="max-w-24 truncate rounded-full bg-background/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur">
                {name}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
