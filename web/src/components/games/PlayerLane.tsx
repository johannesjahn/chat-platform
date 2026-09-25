import type { CSSProperties } from "react";
import { Crown } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";
import { userAvatarName, userLabel } from "@/lib/users";
import type { PublicUser } from "@/lib/api";
import { PlaceBadge } from "./PlaceBadge";

// One racer's lane on the track: who they are, how far along they are (the
// fill grows and their avatar rides its leading edge), their live score,
// and — once they cross the line — their place. Game-agnostic: `progress`
// is just 0..1, `score` whatever the game's headline number is.
export function PlayerLane({
  user,
  progress,
  score,
  scoreUnit,
  place,
  isMe = false,
  isHost = false,
  index = 0,
}: {
  user: PublicUser;
  progress: number;
  score: number | null;
  scoreUnit: string;
  place: number | null;
  isMe?: boolean;
  isHost?: boolean;
  /** Position in the list, for the staggered entrance. */
  index?: number;
}) {
  const clamped = Math.max(0, Math.min(1, progress));
  const finished = place !== null;
  return (
    <div
      style={{ "--stagger-index": index } as CSSProperties}
      className={cn(
        "flex items-center gap-2 rounded-xl border px-2.5 py-2.5 transition-colors duration-300 sm:gap-3 sm:px-3",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-4 motion-safe:duration-500 motion-safe:fill-mode-both stagger-in",
        isMe
          ? "game-ring border-transparent bg-[color-mix(in_oklch,var(--game-from),transparent_90%)]"
          : "border-border/50 bg-background/40",
      )}
    >
      <div className="flex w-24 min-w-0 shrink-0 items-center gap-2 sm:w-40">
        {/* On a phone the rider on the track is the only avatar — the name
            column needs the room. */}
        <Avatar
          name={userAvatarName(user)}
          avatarUrl={user.avatarUrl}
          avatarVariants={user.avatarVariants}
          size="sm"
          className="hidden sm:flex"
        />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="flex items-center gap-1 truncate text-sm font-medium">
            <span className="truncate">{userLabel(user)}</span>
            {isHost && (
              <Crown
                aria-label="Host"
                className="size-3 shrink-0 text-[var(--game-gold)]"
              />
            )}
          </span>
          {isMe && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--game-from)]">
              You
            </span>
          )}
        </span>
      </div>

      {/* The track. The fill's width is the real position; the avatar
          marker rides its leading edge. Both ease rather than snap, since
          positions arrive a few times a second. */}
      <div className="relative h-3 flex-1 rounded-full bg-muted/70">
        <div
          aria-hidden
          className="absolute inset-y-0 right-0 w-px bg-[repeating-linear-gradient(to_bottom,var(--foreground)_0_2px,transparent_2px_4px)] opacity-40"
        />
        <div
          role="progressbar"
          aria-label={`${userLabel(user)}'s progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(clamped * 100)}
          className="game-gradient absolute inset-y-0 left-0 overflow-hidden rounded-full shadow-[0_0_14px_-2px_var(--game-glow)] transition-[width] duration-300 ease-out"
          style={{ width: `${clamped * 100}%` }}
        >
          {!finished && clamped > 0 && (
            <span
              aria-hidden
              className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/40 to-transparent motion-safe:animate-lane-sheen"
            />
          )}
        </div>
        <span
          aria-hidden
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 transition-[left] duration-300 ease-out"
          style={{ left: `${clamped * 100}%` }}
        >
          <span
            className={cn(
              "block rounded-full ring-2 ring-background",
              finished ? "scale-110" : "motion-safe:animate-float",
            )}
          >
            <Avatar
              name={userAvatarName(user)}
              avatarUrl={user.avatarUrl}
              avatarVariants={user.avatarVariants}
              size="sm"
              className="size-6 text-[10px]"
            />
          </span>
        </span>
      </div>

      <div className="flex w-16 shrink-0 items-center justify-end gap-2 sm:w-20">
        <span className="flex flex-col items-end leading-tight">
          <span className="text-base font-bold tabular-nums">
            {score === null ? "—" : Math.round(score)}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {scoreUnit}
          </span>
        </span>
        {place !== null && <PlaceBadge place={place} size="sm" />}
      </div>
    </div>
  );
}
