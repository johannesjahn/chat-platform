import type { CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Eye } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";
import { userAvatarName, userLabel } from "@/lib/users";
import { livePhase, type GameLobby } from "@/lib/games/lobby";
import { PhaseBadge } from "./PhaseBadge";

// One lobby in a game's lobby browser: its host, an overlapping stack of
// everyone seated, how full it is, and its phase. The whole row links into
// the lobby — to join if there's a seat, to spectate if the race is on.
export function LobbyCard({
  lobby,
  gamePath,
  now,
  index = 0,
}: {
  lobby: GameLobby;
  /** The game's slug, for the link. */
  gamePath: string;
  now: number;
  index?: number;
}) {
  const phase = livePhase(lobby, now);
  const host = lobby.players.find((p) => p.user.id === lobby.hostId);
  const joinable =
    phase === "waiting" && lobby.players.length < lobby.maxPlayers;
  return (
    <Link
      to="/games/$game/$lobbyId"
      params={{ game: gamePath, lobbyId: String(lobby.id) }}
      style={{ "--stagger-index": index } as CSSProperties}
      className={cn(
        "group flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-3 transition-all duration-300 ease-smooth",
        "hover:-translate-y-0.5 hover:border-[color-mix(in_oklch,var(--game-from),transparent_50%)] hover:bg-accent/30 hover:shadow-[0_10px_30px_-15px_var(--game-glow)]",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:fill-mode-both motion-safe:duration-500 stagger-in",
      )}
    >
      <div className="flex -space-x-2">
        {lobby.players.slice(0, 4).map((player) => (
          <Avatar
            key={player.user.id}
            name={userAvatarName(player.user)}
            avatarUrl={player.user.avatarUrl}
            avatarVariants={player.user.avatarVariants}
            size="md"
            className="ring-2 ring-card transition-transform duration-300 group-hover:translate-x-0.5"
          />
        ))}
        {lobby.players.length > 4 && (
          <span className="flex size-9 items-center justify-center rounded-full bg-muted text-xs font-semibold ring-2 ring-card">
            +{lobby.players.length - 4}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-semibold">
          {host ? `${userLabel(host.user)}'s lobby` : `Lobby #${lobby.id}`}
        </span>
        <div className="flex items-center gap-2">
          <PhaseBadge phase={phase} />
          <span className="text-xs tabular-nums text-muted-foreground">
            {lobby.players.length}/{lobby.maxPlayers}
          </span>
        </div>
      </div>
      <span className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors group-hover:text-foreground">
        {joinable ? (
          <>
            Join
            <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-1" />
          </>
        ) : (
          <>
            <Eye className="size-4" />
            Watch
          </>
        )}
      </span>
    </Link>
  );
}
