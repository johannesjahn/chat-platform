import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Flame,
  Medal,
  RotateCcw,
  Swords,
  Timer,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { CountUp } from "@/components/reactbits/CountUp";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { useLeaderboard, type GameLobby } from "@/lib/games/lobby";
import {
  comboMultiplier,
  decodeLiveResult,
  scoreResults,
  streakBefore,
  useFinishReflex,
  useReflexEngine,
  type LiveResult,
  type ReflexDirection,
  type ReflexRound,
  type ReflexTap,
  type ReflexView,
} from "@/lib/games/reflex";
import type { GameDefinition } from "@/lib/games/registry";
import { gameProgressLogOf, useGameProgressVersion } from "@/lib/games/rooms";
import { userAvatarName, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";
import { CountdownOverlay } from "../CountdownOverlay";
import { GamePanel } from "../GamePanel";
import { REFLEX_KIND_ICONS } from "./kinds";
import { ReflexArena } from "./ReflexArena";
import { ResultPill } from "./ResultPill";

const KEY_DIRECTIONS: Partial<Record<string, ReflexDirection>> = {
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
};

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT");

// Reflex Rush's play area: the arena everyone watches, the player's own
// score line above it, and the duel board below — every player's rounds
// filling in live as they're played.
export function ReflexGame({
  game,
  lobby,
  meId,
  now,
}: {
  game: GameDefinition;
  lobby: GameLobby;
  meId: number | undefined;
  now: number;
}) {
  const reflex = lobby.reflex!;
  const rounds = reflex.rounds;
  const me = lobby.players.find((player) => player.user.id === meId);
  const submitted = me?.durationMs != null;

  const finish = useFinishReflex(lobby.id);
  const { mutate } = finish;
  // Kept for a retry, should the submission fail on its way out.
  const [lastTaps, setLastTaps] = useState<ReflexTap[] | null>(null);
  const onComplete = useCallback(
    (taps: ReflexTap[]) => {
      setLastTaps(taps);
      mutate(taps);
    },
    [mutate],
  );
  const { view, results, whiffs, press } = useReflexEngine({
    lobbyId: lobby.id,
    lobbyRound: lobby.round,
    rounds,
    introMs: reflex.introMs,
    enabled: !!me && !submitted,
    onComplete,
  });
  const playing = !!me && !submitted;

  // Keys play too — Space/Enter for "now", arrows (or WASD) for Arrows
  // rounds — but never while typing in the lobby chat.
  useEffect(() => {
    if (!playing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (isEditable(event.target)) return;
      const direction = KEY_DIRECTIONS[event.code];
      if (!direction && event.code !== "Space" && event.code !== "Enter") {
        return;
      }
      // No scrolling the page, and no "clicking" a focused button.
      event.preventDefault();
      press({ source: "key", at: event.timeStamp, direction });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, press]);

  // As play begins: bring the arena into view (the start button sat further
  // down the waiting room), and clear focus off any button, which would
  // swallow Space as a click.
  const arenaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    arenaRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);
  useEffect(() => {
    if (!playing) return;
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement) active.blur();
  }, [playing]);

  // Everyone's rounds: mine as I play them, others' from their live frames,
  // and the server's scored breakdown as soon as it's in.
  useGameProgressVersion();
  const board = lobby.players.map((player) => {
    const scored = reflex.results.find((r) => r.userId === player.user.id);
    let rows: ReadonlyArray<LiveResult | undefined>;
    if (scored) {
      rows = scored.rounds;
    } else if (player.user.id === meId) {
      rows = results;
    } else {
      const live: LiveResult[] = [];
      for (const value of gameProgressLogOf(lobby.id, player.user.id)) {
        const decoded = decodeLiveResult(value);
        if (decoded && decoded.index < rounds.length) {
          live[decoded.index] = decoded.result;
        }
      }
      rows = live;
    }
    const total = scored
      ? (player.score ?? 0)
      : scoreResults(rounds, rows).total;
    return { player, rows, total };
  });
  const fastestIn = (index: number) => {
    let best: { name: string; ms: number; userId: number } | null = null;
    for (const { player, rows } of board) {
      const row = rows[index];
      if (row?.outcome !== "hit" || row.reactionMs === null) continue;
      if (!best || row.reactionMs < best.ms) {
        best = {
          name: userLabel(player.user),
          ms: row.reactionMs,
          userId: player.user.id,
        };
      }
    }
    return best;
  };

  const mine = scoreResults(rounds, results);
  const streak = streakBefore(results, view.index);
  // The streak going *into* the next round, once this one's played.
  const liveStreak = streakBefore(results, results.length);
  const hits = results.filter((r) => r?.outcome === "hit" && r.reactionMs);
  const bestMs = hits.length
    ? Math.min(...hits.map((r) => r!.reactionMs!))
    : null;
  const personalBest = useLeaderboard("reflex", "all", !!me).data?.me
    ?.bestScore;
  const startsAt = lobby.startsAt ?? now;
  const solo = lobby.players.length === 1;

  return (
    <div className="flex flex-col gap-4">
      <GamePanel className="relative gap-3 p-3 sm:p-5" live={playing}>
        <RoundTrack rounds={rounds} results={results} view={view} />
        {me && (
          <div className="grid grid-cols-3 gap-2">
            <HudStat label="Score" icon={Trophy} emphasis>
              <CountUp value={mine.total} duration={450} />
            </HudStat>
            <HudStat label="Combo" icon={Flame}>
              <span
                key={liveStreak}
                className={cn(
                  "inline-block",
                  liveStreak > 0 && "motion-safe:animate-reflex-pop-in",
                  liveStreak >= 3 && "text-[var(--game-gold)]",
                )}
              >
                ×{comboMultiplier(liveStreak).toFixed(1)}
              </span>
            </HudStat>
            <HudStat
              label={
                <>
                  Best
                  {personalBest !== undefined && (
                    <span className="hidden normal-case sm:inline">
                      · PB {Math.round(personalBest)} pts
                    </span>
                  )}
                </>
              }
              icon={Timer}
            >
              {bestMs === null ? "—" : `${bestMs}ms`}
            </HudStat>
          </div>
        )}
        <ReflexArena
          ref={arenaRef}
          rounds={rounds}
          view={view}
          result={me ? results[view.index] : undefined}
          streak={streak}
          whiffs={whiffs}
          interactive={playing}
          onPress={press}
          fastest={fastestIn(view.index)}
        >
          <CountdownOverlay
            startsAt={startsAt}
            now={now}
            hint={
              me
                ? "Hands ready — tap, click, or Space on the signal"
                : "You're spectating — enjoy the show"
            }
          />
        </ReflexArena>
        {finish.error && (
          <div
            className="flex flex-wrap items-center justify-center gap-2 text-sm text-destructive"
            role="alert"
          >
            {errorMessage(finish.error)}
            {lastTaps && (
              <Button
                size="sm"
                variant="outline"
                disabled={finish.isPending}
                onClick={() => mutate(lastTaps)}
              >
                <RotateCcw className="size-4" />
                Send again
              </Button>
            )}
          </div>
        )}
      </GamePanel>

      <GamePanel
        title={solo ? "Your run" : "Duel"}
        icon={solo ? Medal : Swords}
        actions={
          <span className="text-xs text-muted-foreground">
            {game.scoreUnit} live · final once everyone&apos;s in
          </span>
        }
      >
        <div className="flex flex-col gap-2">
          {[...board]
            .sort((a, b) => b.total - a.total)
            .map(({ player, rows, total }, index) => (
              <div
                key={player.user.id}
                style={{ "--stagger-index": index } as CSSProperties}
                className={cn(
                  // On a phone the rounds get a line of their own.
                  "flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border px-2.5 py-2 transition-colors sm:flex-nowrap sm:gap-3 sm:px-3",
                  "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-4 motion-safe:fill-mode-both stagger-in",
                  player.user.id === meId
                    ? "game-ring border-transparent bg-[color-mix(in_oklch,var(--game-from),transparent_90%)]"
                    : "border-border/50 bg-background/40",
                )}
              >
                <span className="w-4 text-center text-xs font-bold tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <Avatar
                  name={userAvatarName(player.user)}
                  avatarUrl={player.user.avatarUrl}
                  avatarVariants={player.user.avatarVariants}
                  size="sm"
                  className="hidden sm:flex"
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium sm:w-28 sm:flex-none">
                  {userLabel(player.user)}
                </span>
                <div
                  className="order-last grid basis-full gap-1 sm:order-none sm:flex-1 sm:basis-auto"
                  style={{
                    gridTemplateColumns: `repeat(${rounds.length}, minmax(0, 1fr))`,
                  }}
                >
                  {rounds.map((_, i) => (
                    <ResultPill
                      key={i}
                      result={rows[i]}
                      current={i === view.index && view.stage !== "done"}
                      fastest={!solo && fastestIn(i)?.userId === player.user.id}
                    />
                  ))}
                </div>
                <span className="w-14 text-right text-base font-bold tabular-nums">
                  <CountUp value={Math.round(total)} duration={450} />
                </span>
              </div>
            ))}
        </div>
      </GamePanel>
    </div>
  );
}

function HudStat({
  label,
  icon: Icon,
  emphasis = false,
  children,
}: {
  label: ReactNode;
  icon: LucideIcon;
  emphasis?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl border border-border/60 bg-background/40 px-3 py-2">
      <span className="flex items-center gap-1 truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground sm:text-xs">
        <Icon className="size-3 shrink-0" />
        {label}
      </span>
      <span
        className={cn(
          "text-lg font-bold tabular-nums tracking-tight sm:text-2xl",
          emphasis &&
            "text-[var(--game-from)] drop-shadow-[0_0_12px_var(--game-glow)]",
        )}
      >
        {children}
      </span>
    </div>
  );
}

// The game's rounds as a strip of tiles: each kind's glyph, filled in with
// how the round went, the one being played pulsing.
function RoundTrack({
  rounds,
  results,
  view,
}: {
  rounds: ReadonlyArray<ReflexRound>;
  results: ReadonlyArray<LiveResult | undefined>;
  view: ReflexView;
}) {
  return (
    <ol
      className="grid gap-1.5"
      style={{
        gridTemplateColumns: `repeat(${rounds.length}, minmax(0, 1fr))`,
      }}
      aria-label="Rounds"
    >
      {rounds.map((round, index) => {
        const Icon = REFLEX_KIND_ICONS[round.kind];
        const result = results[index];
        const current =
          index === view.index &&
          view.stage !== "before" &&
          view.stage !== "done";
        return (
          <li
            key={index}
            className={cn(
              "flex h-8 items-center justify-center rounded-lg border text-muted-foreground transition-colors duration-300",
              current &&
                "motion-safe:animate-reflex-current border-[var(--game-from)] text-foreground",
              !result && !current && "border-border/50 bg-background/30",
              result?.outcome === "hit" &&
                "border-transparent bg-[oklch(0.72_0.19_150/0.25)] text-[oklch(0.8_0.19_150)]",
              result?.outcome === "early" &&
                "border-transparent bg-[oklch(0.62_0.22_25/0.25)] text-[oklch(0.72_0.2_25)]",
              (result?.outcome === "miss" || result?.outcome === "wrong") &&
                "border-transparent bg-muted/60",
            )}
          >
            <Icon className="size-3.5" aria-label={round.kind} />
          </li>
        );
      })}
    </ol>
  );
}
