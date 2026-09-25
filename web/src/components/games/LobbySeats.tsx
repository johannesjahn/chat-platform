import type { CSSProperties } from "react";
import { Crown, UserPlus } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";
import { userAvatarName, userLabel } from "@/lib/users";
import type { GameLobby } from "@/lib/games/lobby";

// The waiting room: one seat per slot, taken seats popping in with their
// player (the host crowned), empty ones breathing while they wait.
export function LobbySeats({
  lobby,
  meId,
}: {
  lobby: GameLobby;
  meId: number | undefined;
}) {
  const empty = Math.max(0, lobby.maxPlayers - lobby.players.length);
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {lobby.players.map((player, index) => (
        <li
          key={player.user.id}
          style={{ "--stagger-index": index } as CSSProperties}
          className={cn(
            "relative flex flex-col items-center gap-2 rounded-xl border bg-background/40 px-3 py-4 text-center",
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90 motion-safe:fill-mode-both motion-safe:duration-500 stagger-in",
            player.user.id === meId
              ? "game-ring border-transparent"
              : "border-border/60",
          )}
        >
          {player.user.id === lobby.hostId && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-[color-mix(in_oklch,var(--game-gold),transparent_80%)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--game-gold)]">
              <Crown className="size-3" />
              Host
            </span>
          )}
          <Avatar
            name={userAvatarName(player.user)}
            avatarUrl={player.user.avatarUrl}
            avatarVariants={player.user.avatarVariants}
            size="lg"
          />
          <span className="max-w-full truncate text-sm font-medium">
            {userLabel(player.user)}
          </span>
        </li>
      ))}
      {Array.from({ length: empty }, (_, i) => (
        <li
          key={`empty-${i}`}
          className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 px-3 py-4 text-muted-foreground motion-safe:animate-seat-breathe"
          style={{ animationDelay: `${i * 300}ms` }}
        >
          <span className="flex size-11 items-center justify-center rounded-full border border-dashed border-border">
            <UserPlus className="size-4" />
          </span>
          <span className="text-xs">Open seat</span>
        </li>
      ))}
    </ul>
  );
}
