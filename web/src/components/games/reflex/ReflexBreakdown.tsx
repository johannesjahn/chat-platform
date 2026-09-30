import type { CSSProperties } from "react";
import { Activity, Gauge, Skull, Zap, type LucideIcon } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import type { GameLobby } from "@/lib/games/lobby";
import { REFLEX_KIND_COPY } from "@/lib/games/reflex";
import { userAvatarName, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";
import { GamePanel } from "../GamePanel";
import { REFLEX_KIND_ICONS } from "./kinds";
import { ResultPill } from "./ResultPill";

// Under the podium: the whole game round by round — every player's times
// side by side (the quickest of each round crowned), and a few highlights.
export function ReflexBreakdown({ lobby }: { lobby: GameLobby }) {
  const reflex = lobby.reflex;
  if (!reflex || reflex.rounds.length === 0 || reflex.results.length === 0) {
    return null;
  }
  const { rounds } = reflex;
  const rows = lobby.players
    .flatMap((player) => {
      const result = reflex.results.find((r) => r.userId === player.user.id);
      return result ? [{ player, rounds: result.rounds }] : [];
    })
    .sort((a, b) => (a.player.place ?? 99) - (b.player.place ?? 99));

  const fastestOf = (index: number) => {
    let best: number | null = null;
    for (const row of rows) {
      const round = row.rounds[index];
      if (round?.outcome === "hit" && round.reactionMs !== null) {
        best =
          best === null ? round.reactionMs : Math.min(best, round.reactionMs);
      }
    }
    return best;
  };
  const stats = rows.map((row) => {
    const times = row.rounds.flatMap((round) =>
      round.outcome === "hit" && round.reactionMs !== null
        ? [round.reactionMs]
        : [],
    );
    return {
      ...row,
      average: times.length
        ? Math.round(times.reduce((sum, t) => sum + t, 0) / times.length)
        : null,
      best: times.length ? Math.min(...times) : null,
      falseStarts: row.rounds.filter((round) => round.outcome === "early")
        .length,
    };
  });

  // Highlights across the whole lobby.
  let quickest: { name: string; ms: number; round: number } | null = null;
  for (const row of rows) {
    for (const [index, round] of row.rounds.entries()) {
      if (round.outcome !== "hit" || round.reactionMs === null) continue;
      if (!quickest || round.reactionMs < quickest.ms) {
        quickest = {
          name: userLabel(row.player.user),
          ms: round.reactionMs,
          round: index,
        };
      }
    }
  }
  const steadiest = stats
    .filter((s) => s.average !== null)
    .sort((a, b) => a.average! - b.average!)[0];
  const jumpiest = [...stats].sort((a, b) => b.falseStarts - a.falseStarts)[0];
  const solo = rows.length === 1;

  return (
    <GamePanel title="Round by round" icon={Activity}>
      <div className="grid gap-2 sm:grid-cols-3">
        {quickest && (
          <Highlight
            icon={Zap}
            label="Quickest hit"
            value={`${quickest.ms} ms`}
            detail={`${solo ? "Round" : `${quickest.name} · round`} ${quickest.round + 1}, ${REFLEX_KIND_COPY[rounds[quickest.round]!.kind].title}`}
            index={0}
          />
        )}
        {steadiest && (
          <Highlight
            icon={Gauge}
            label={solo ? "Average" : "Best average"}
            value={`${steadiest.average} ms`}
            detail={
              solo ? "over every clean hit" : userLabel(steadiest.player.user)
            }
            index={1}
          />
        )}
        {jumpiest && (
          <Highlight
            icon={Skull}
            label="False starts"
            value={String(jumpiest.falseStarts)}
            detail={
              jumpiest.falseStarts === 0
                ? "Nerves of steel all round"
                : solo
                  ? "Patience pays"
                  : `Jumpiest: ${userLabel(jumpiest.player.user)}`
            }
            index={2}
          />
        )}
      </div>

      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[34rem] border-separate border-spacing-y-1.5 text-sm">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left text-xs font-medium">Player</th>
              {rounds.map((round, index) => {
                const Icon = REFLEX_KIND_ICONS[round.kind];
                return (
                  <th
                    key={index}
                    className="px-0.5 font-normal"
                    title={REFLEX_KIND_COPY[round.kind].title}
                  >
                    <Icon className="mx-auto size-3.5" />
                  </th>
                );
              })}
              <th className="text-right text-xs font-medium">Avg</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((row, rowIndex) => (
              <tr
                key={row.player.user.id}
                style={{ "--stagger-index": rowIndex } as CSSProperties}
                className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:fill-mode-both stagger-in"
              >
                <td className="pr-2">
                  <span className="flex items-center gap-2">
                    <Avatar
                      name={userAvatarName(row.player.user)}
                      avatarUrl={row.player.user.avatarUrl}
                      avatarVariants={row.player.user.avatarVariants}
                      size="sm"
                    />
                    <span className="max-w-24 truncate font-medium">
                      {userLabel(row.player.user)}
                    </span>
                  </span>
                </td>
                {row.rounds.map((round, index) => (
                  <td key={index} className="px-0.5">
                    <ResultPill
                      result={round}
                      className="w-full"
                      fastest={
                        !solo &&
                        round.outcome === "hit" &&
                        round.reactionMs === fastestOf(index)
                      }
                    />
                  </td>
                ))}
                <td className="pl-2 text-right font-bold tabular-nums">
                  {row.average === null ? "—" : row.average}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </GamePanel>
  );
}

function Highlight({
  icon: Icon,
  label,
  value,
  detail,
  index,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  index: number;
}) {
  return (
    <div
      style={{ "--stagger-index": index } as CSSProperties}
      className={cn(
        "flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-4 py-3",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:fill-mode-both stagger-in",
      )}
    >
      <span className="game-gradient flex size-9 shrink-0 items-center justify-center rounded-lg text-white">
        <Icon className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="text-xl font-bold tabular-nums">{value}</span>
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </div>
  );
}
