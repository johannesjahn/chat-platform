import { useState, type CSSProperties } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Crown,
  DoorOpen,
  Flag,
  Plus,
  Swords,
  Trophy,
  Users,
  Zap,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { GamePanel } from "@/components/games/GamePanel";
import { GameShell } from "@/components/games/GameShell";
import { GameStat } from "@/components/games/GameStat";
import { LeaderboardTable } from "@/components/games/LeaderboardTable";
import { LobbyCard } from "@/components/games/LobbyCard";
import { SegmentedControl } from "@/components/games/SegmentedControl";
import { LoginPrompt } from "@/components/LoginPrompt";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import {
  useCreateLobby,
  useGameLobbies,
  useLeaderboard,
  useQuickPlay,
  useServerClock,
  type LeaderboardPeriod,
} from "@/lib/games/lobby";
import { GAMES, getGame, type GameId } from "@/lib/games/registry";
import { gameHubRoom, useGameRoom } from "@/lib/games/rooms";

export const Route = createFileRoute("/games/$game/")({
  component: GameHubRoute,
});

const PERIODS: ReadonlyArray<{ value: LeaderboardPeriod; label: string }> = [
  { value: "day", label: "Today" },
  { value: "week", label: "This week" },
  { value: "all", label: "All time" },
];

const STEPS = [
  {
    icon: Users,
    title: "Gather",
    text: "Quick play drops you into the fullest open lobby — or open your own and share the link.",
  },
  {
    icon: Zap,
    title: "Race",
    text: "The host starts a countdown. Everyone gets the same passage; every lane moves live.",
  },
  {
    icon: Trophy,
    title: "Climb",
    text: "Every finish counts toward the leaderboard. Speed ranks you; wins need an opponent.",
  },
];

function GameHubRoute() {
  const { game } = Route.useParams();
  const known = GAMES.find((g) => g.id === game && g.status === "live");
  if (!known) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-10">
        <EmptyState
          icon={Swords}
          title="Game not found"
          description="That game isn't in the arcade (yet)."
        />
      </main>
    );
  }
  return <GameHub gameId={game as GameId} />;
}

function GameHub({ gameId }: { gameId: GameId }) {
  const game = getGame(gameId);
  const session = useSession();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<LeaderboardPeriod>("week");

  useGameRoom(session ? gameHubRoom(gameId) : null);
  const lobbies = useGameLobbies(gameId, !!session);
  const leaderboard = useLeaderboard(gameId, period, !!session);
  const quickPlay = useQuickPlay(gameId);
  const createLobby = useCreateLobby(gameId);
  // Only needed to show each lobby's phase moving (countdown → live).
  const now = useServerClock(1000, !!session);

  const goTo = (lobbyId: number) =>
    void navigate({
      to: "/games/$game/$lobbyId",
      params: { game: gameId, lobbyId: String(lobbyId) },
    });
  const busy = quickPlay.isPending || createLobby.isPending;
  const actionError = quickPlay.error ?? createLobby.error;
  const me = leaderboard.data?.me;

  return (
    <GameShell
      game={game}
      back={{ label: "Arcade" }}
      actions={
        session && (
          <>
            <Button
              size="lg"
              disabled={busy}
              onClick={() =>
                quickPlay.mutate(undefined, { onSuccess: (l) => goTo(l.id) })
              }
              className="game-gradient border-0 text-white shadow-lg shadow-[var(--game-glow)] hover:opacity-95"
            >
              <Zap className="size-4" />
              Quick play
            </Button>
            <Button
              size="lg"
              variant="outline"
              disabled={busy}
              onClick={() =>
                createLobby.mutate(undefined, { onSuccess: (l) => goTo(l.id) })
              }
            >
              <Plus className="size-4" />
              New lobby
            </Button>
          </>
        )
      }
    >
      {!session ? (
        <LoginPrompt
          title={`Log in to play ${game.name}`}
          description="Sign in to join a lobby, race others live, and get on the leaderboard."
        />
      ) : (
        <>
          {actionError && (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage(actionError)}
            </p>
          )}

          <ol className="grid gap-3 sm:grid-cols-3">
            {STEPS.map((step, index) => (
              <li
                key={step.title}
                style={{ "--stagger-index": index } as CSSProperties}
                className="flex gap-3 rounded-xl border border-border/50 bg-card/50 p-4 backdrop-blur motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:fill-mode-both motion-safe:duration-500 stagger-in"
              >
                <span className="game-gradient flex size-8 shrink-0 items-center justify-center rounded-lg text-white">
                  <step.icon className="size-4" />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-semibold">
                    {index + 1}. {step.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {step.text}
                  </span>
                </span>
              </li>
            ))}
          </ol>

          <div className="grid gap-6 lg:grid-cols-5">
            <GamePanel
              title="Open lobbies"
              icon={DoorOpen}
              className="lg:col-span-2"
              actions={
                lobbies.data && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {lobbies.data.length} open
                  </span>
                )
              }
            >
              {lobbies.isLoading ? (
                <div className="flex flex-col gap-2">
                  {Array.from({ length: 3 }, (_, i) => (
                    <Skeleton key={i} className="h-16 w-full rounded-xl" />
                  ))}
                </div>
              ) : lobbies.error ? (
                <p className="text-sm text-destructive">
                  {errorMessage(lobbies.error)}
                </p>
              ) : lobbies.data && lobbies.data.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {lobbies.data.map((lobby, index) => (
                    <LobbyCard
                      key={lobby.id}
                      lobby={lobby}
                      gamePath={gameId}
                      now={now}
                      index={index}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={Flag}
                  title="No open lobbies"
                  description="Be the first — open a lobby and share the link, or hit Quick play."
                  className="py-8"
                />
              )}
            </GamePanel>

            <GamePanel
              title="Leaderboard"
              icon={Trophy}
              className="lg:col-span-3"
              actions={
                <SegmentedControl
                  label="Leaderboard period"
                  options={PERIODS}
                  value={period}
                  onChange={setPeriod}
                />
              }
            >
              {me && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <GameStat
                    label={
                      <span className="inline-flex items-center gap-1">
                        <Crown className="size-3" />
                        Your rank
                      </span>
                    }
                    value={me.rank}
                    emphasis
                  />
                  <GameStat
                    label="Best"
                    value={me.bestScore}
                    unit={game.scoreUnit}
                    style={{ "--stagger-index": 1 } as CSSProperties}
                  />
                  <GameStat
                    label="Races"
                    value={me.races}
                    style={{ "--stagger-index": 2 } as CSSProperties}
                  />
                  <GameStat
                    label="Wins"
                    value={me.wins}
                    style={{ "--stagger-index": 3 } as CSSProperties}
                  />
                </div>
              )}
              <LeaderboardTable
                key={period}
                entries={leaderboard.data?.entries}
                me={me}
                scoreUnit={game.scoreUnit}
                isLoading={leaderboard.isLoading}
              />
            </GamePanel>
          </div>
        </>
      )}
    </GameShell>
  );
}
