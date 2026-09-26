import type { CSSProperties } from "react";
import { Trophy } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { userAvatarName, userLabel } from "@/lib/users";
import type { LeaderboardEntry } from "@/lib/games/lobby";
import { PlaceBadge } from "./PlaceBadge";

function Row({
  entry,
  scoreUnit,
  isMe,
  index,
  pinned = false,
}: {
  entry: LeaderboardEntry;
  scoreUnit: string;
  isMe: boolean;
  index: number;
  pinned?: boolean;
}) {
  return (
    <li
      style={{ "--stagger-index": index } as CSSProperties}
      className={cn(
        "grid grid-cols-[2rem_1fr_5.5rem] items-center gap-3 rounded-xl px-3 py-2 sm:grid-cols-[2rem_1fr_repeat(3,4rem)_5.5rem]",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:fill-mode-both motion-safe:duration-500 stagger-in",
        "transition-colors duration-200 hover:bg-accent/40",
        isMe &&
          "game-ring bg-[color-mix(in_oklch,var(--game-from),transparent_90%)]",
        pinned && "mt-2",
      )}
    >
      <PlaceBadge place={entry.rank} size="sm" delayMs={index * 55} />
      <span className="flex min-w-0 items-center gap-2.5">
        <Avatar
          name={userAvatarName(entry.user)}
          avatarUrl={entry.user.avatarUrl}
          avatarVariants={entry.user.avatarVariants}
          size="sm"
        />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-medium">
            {userLabel(entry.user)}
          </span>
          {isMe && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--game-from)]">
              You
            </span>
          )}
        </span>
      </span>
      <span className="hidden text-right text-sm tabular-nums text-muted-foreground sm:block">
        {Math.round(entry.averageScore)}
      </span>
      <span className="hidden text-right text-sm tabular-nums text-muted-foreground sm:block">
        {entry.averageAccuracy.toFixed(0)}%
      </span>
      <span className="hidden text-right text-sm tabular-nums text-muted-foreground sm:block">
        {entry.wins}/{entry.races}
      </span>
      <span className="flex items-baseline justify-end gap-1 pl-2">
        <span
          className={cn(
            "text-lg font-bold tabular-nums",
            entry.rank <= 3 && "game-text",
          )}
        >
          {Math.round(entry.bestScore)}
        </span>
        <span className="text-[10px] uppercase text-muted-foreground">
          {scoreUnit}
        </span>
      </span>
    </li>
  );
}

// A game's leaderboard: medal ranks, each player's best score in the game's
// gradient, and — on wider screens — average, accuracy, and wins/races. The
// viewer's own row glows, and if they're ranked below the cut it's pinned
// underneath so "where am I?" always has an answer.
export function LeaderboardTable({
  entries,
  me,
  scoreUnit,
  isLoading,
}: {
  entries: ReadonlyArray<LeaderboardEntry> | undefined;
  me: LeaderboardEntry | null | undefined;
  scoreUnit: string;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-11 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (!entries || entries.length === 0) {
    return (
      <EmptyState
        icon={Trophy}
        title="No races yet"
        description="Finish a race to put your name on the board."
        className="py-8"
      />
    );
  }
  const meInList = me && entries.some((e) => e.user.id === me.user.id);
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-[2rem_1fr_5.5rem] gap-3 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:grid-cols-[2rem_1fr_repeat(3,4rem)_5.5rem]">
        <span>#</span>
        <span>Player</span>
        <span className="hidden text-right sm:block">Avg</span>
        <span className="hidden text-right sm:block">Acc</span>
        <span className="hidden text-right sm:block">Wins</span>
        <span className="text-right">Best</span>
      </div>
      <ol className="flex flex-col gap-1">
        {entries.map((entry, index) => (
          <Row
            key={entry.user.id}
            entry={entry}
            scoreUnit={scoreUnit}
            isMe={entry.user.id === me?.user.id}
            index={index}
          />
        ))}
        {me && !meInList && (
          <Row
            entry={me}
            scoreUnit={scoreUnit}
            isMe
            index={entries.length}
            pinned
          />
        )}
      </ol>
    </div>
  );
}
