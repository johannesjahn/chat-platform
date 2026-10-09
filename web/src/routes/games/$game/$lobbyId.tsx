import { useEffect, useRef, useState, type ComponentType } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Check,
  DoorOpen,
  Eye,
  Link2,
  LogOut,
  Play,
  RotateCcw,
  Swords,
  Trophy,
  Users,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Confetti } from "@/components/games/Confetti";
import { GamePanel } from "@/components/games/GamePanel";
import { GameShell } from "@/components/games/GameShell";
import { InvitePlayers } from "@/components/games/InvitePlayers";
import { LobbyChat } from "@/components/games/LobbyChat";
import { LobbySeats } from "@/components/games/LobbySeats";
import { PhaseBadge } from "@/components/games/PhaseBadge";
import { ReactionStream } from "@/components/games/ReactionStream";
import { ResultsPodium } from "@/components/games/ResultsPodium";
import { SketchyGallery } from "@/components/games/drawing/SketchyGallery";
import { SketchyGame } from "@/components/games/drawing/SketchyGame";
import { SketchySettings } from "@/components/games/drawing/SketchySettings";
import { ReflexBreakdown } from "@/components/games/reflex/ReflexBreakdown";
import { ReflexGame } from "@/components/games/reflex/ReflexGame";
import { ReflexGuide } from "@/components/games/reflex/ReflexGuide";
import { TypingRace } from "@/components/games/typing/TypingRace";
import { LoginPrompt } from "@/components/LoginPrompt";
import { TypingDots } from "@/components/reactbits/TypingDots";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import {
  gameLobbyQueryKey,
  livePhase,
  useGameLobby,
  useLeaveLobby,
  useLobbyAction,
  usePauseAurora,
  useServerClock,
  type GameLobby,
} from "@/lib/games/lobby";
import {
  GAMES,
  gameTitle,
  getGame,
  type GameDefinition,
  type GameId,
} from "@/lib/games/registry";
import {
  gameLobbyRoom,
  resetGameProgress,
  useGameRoom,
} from "@/lib/games/rooms";
import { userLabel } from "@/lib/users";
import { staticTitle } from "@/lib/title";

export const Route = createFileRoute("/games/$game/$lobbyId")({
  head: ({ params }) => staticTitle(`${gameTitle(params.game)} lobby`),
  component: LobbyRoute,
});

type PlayAreaProps = {
  game: GameDefinition;
  lobby: GameLobby;
  meId: number | undefined;
  now: number;
};

// The only per-game piece of a lobby page: what's on screen while the game
// runs. Everything around it — waiting room, countdown, results, rematch —
// is shared. A new game registers its play area here.
const PLAY_AREAS: Record<GameId, ComponentType<PlayAreaProps>> = {
  typing: TypingRace,
  drawing: SketchyGame,
  reflex: ReflexGame,
};

// Optional extras a game can slot into the shared pages: settings the host
// picks in the waiting room, and something to show under the podium.
const LOBBY_SETTINGS: Partial<
  Record<GameId, ComponentType<{ lobby: GameLobby; isHost: boolean }>>
> = {
  drawing: SketchySettings,
  reflex: ReflexGuide,
};
const RESULTS_EXTRAS: Partial<
  Record<GameId, ComponentType<{ lobby: GameLobby }>>
> = {
  drawing: SketchyGallery,
  reflex: ReflexBreakdown,
};

function LobbyRoute() {
  const { game, lobbyId } = Route.useParams();
  const id = Number(lobbyId);
  const known = GAMES.find((g) => g.id === game && g.status === "live");
  if (!known || !Number.isInteger(id)) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-10">
        <EmptyState
          icon={Swords}
          title="Lobby not found"
          description="This lobby doesn't exist."
        >
          <Button asChild>
            <Link to="/games">Back to the arcade</Link>
          </Button>
        </EmptyState>
      </main>
    );
  }
  return <LobbyPage gameId={game as GameId} lobbyId={id} />;
}

function LobbyPage({ gameId, lobbyId }: { gameId: GameId; lobbyId: number }) {
  const game = getGame(gameId);
  const session = useSession();
  const meId = session?.user.id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useGameRoom(session ? gameLobbyRoom(lobbyId) : null);
  const { data: lobby, isLoading, error } = useGameLobby(lobbyId, !!session);

  // A fast clock through the countdown (so the numbers land on the beat), a
  // steadier one while racing, none while waiting or done.
  const serverPhase = lobby?.phase;
  const now = useServerClock(
    serverPhase === "countdown" ? 50 : 200,
    serverPhase === "countdown" || serverPhase === "racing",
  );
  const phase = lobby ? livePhase(lobby, now) : undefined;
  usePauseAurora(phase === "countdown" || phase === "racing");

  // The race can end on the clock (time limit) with no event to say so —
  // refetch to pick up the server's final word the moment it does.
  useEffect(() => {
    if (phase === "finished" && serverPhase !== "finished") {
      void queryClient.invalidateQueries({
        queryKey: gameLobbyQueryKey(lobbyId),
      });
    }
  }, [phase, serverPhase, lobbyId, queryClient]);

  // Live positions belong to one round: once the lobby is back to waiting
  // (a rematch — whoever pressed it), last round's are wiped, or the next
  // round's would sit behind them (positions only ever move forward).
  useEffect(() => {
    if (phase === "waiting") resetGameProgress(lobbyId);
  }, [phase, lobbyId]);

  const join = useLobbyAction(lobbyId, "join");
  const start = useLobbyAction(lobbyId, "start");
  const rematch = useLobbyAction(lobbyId, "rematch");
  const leave = useLeaveLobby(lobbyId);
  const actionError = join.error ?? start.error ?? rematch.error ?? leave.error;

  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copyInvite = () => {
    void navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    });
  };

  if (!session) {
    return (
      <GameShell game={game} back={{ game: gameId, label: game.name }}>
        <LoginPrompt
          title="Log in to join this lobby"
          description="Sign in to play — or watch — with everyone here."
        />
      </GameShell>
    );
  }

  if (isLoading) {
    return (
      <GameShell game={game} back={{ game: gameId, label: game.name }}>
        <Skeleton className="h-64 w-full rounded-2xl" />
      </GameShell>
    );
  }

  if (error || !lobby || !phase) {
    return (
      <GameShell game={game} back={{ game: gameId, label: game.name }}>
        <EmptyState
          icon={DoorOpen}
          title="This lobby has closed"
          description="Everyone left, or the link is wrong. Find another game in the lobby browser."
        >
          <Button asChild>
            <Link to="/games/$game" params={{ game: gameId }}>
              Browse lobbies
            </Link>
          </Button>
        </EmptyState>
      </GameShell>
    );
  }

  const me = lobby.players.find((p) => p.user.id === meId);
  const isHost = lobby.hostId === meId;
  const host = lobby.players.find((p) => p.user.id === lobby.hostId);
  const full = lobby.players.length >= lobby.maxPlayers;
  const missing = Math.max(0, lobby.minPlayers - lobby.players.length);
  const PlayArea = PLAY_AREAS[gameId];
  const Settings = LOBBY_SETTINGS[gameId];
  const ResultsExtras = RESULTS_EXTRAS[gameId];
  const won =
    phase === "finished" && me?.place === 1 && lobby.players.length > 1;

  return (
    <GameShell
      game={game}
      back={{ game: gameId, label: game.name }}
      // Wider from `lg`, where the lobby chat moves beside the game rather
      // than under it, and wider again at `xl` so the play areas can grow
      // (issue #554).
      className="lg:max-w-7xl xl:max-w-[90rem]"
      title={host ? `${userLabel(host.user)}'s lobby` : `Lobby #${lobby.id}`}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <PhaseBadge phase={phase} />
          <span className="inline-flex items-center gap-1 text-xs tabular-nums">
            <Users className="size-3.5" />
            {lobby.players.length}/{lobby.maxPlayers}
          </span>
          {lobby.round > 1 && (
            <span className="text-xs">Round {lobby.round}</span>
          )}
          {!me && (
            <span className="inline-flex items-center gap-1 text-xs">
              <Eye className="size-3.5" />
              Spectating
            </span>
          )}
        </span>
      }
      actions={
        <>
          <Button variant="outline" size="sm" onClick={copyInvite}>
            {copied ? (
              <Check className="size-4 text-emerald-600 dark:text-emerald-400 motion-safe:animate-like-pop" />
            ) : (
              <Link2 className="size-4" />
            )}
            {copied ? "Copied!" : "Invite link"}
          </Button>
          {me && (
            <Button
              variant="ghost"
              size="sm"
              disabled={leave.isPending}
              onClick={() =>
                leave.mutate(undefined, {
                  onSuccess: () =>
                    void navigate({
                      to: "/games/$game",
                      params: { game: gameId },
                    }),
                })
              }
            >
              <LogOut className="size-4" />
              Leave
            </Button>
          )}
        </>
      }
    >
      {won && <Confetti key={lobby.round} />}
      {/* Below `lg` the chat follows the game down the page; from `lg` it's
          a full-height panel to its right, so the waiting room and results
          never scroll it out of reach (issue #554). */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {actionError && (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage(actionError)}
            </p>
          )}

          {phase === "waiting" && (
            <GamePanel
              title="Waiting room"
              icon={Users}
              live={isHost}
              actions={
                <span className="text-xs text-muted-foreground">
                  Invite players or share the link to fill the seats
                </span>
              }
            >
              <LobbySeats lobby={lobby} meId={meId} />
              {me && !full && (
                <div className="flex justify-center">
                  <InvitePlayers lobby={lobby} meId={meId} />
                </div>
              )}
              {Settings && <Settings lobby={lobby} isHost={isHost} />}
              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                {isHost ? (
                  <div className="flex flex-col items-center gap-1.5">
                    <Button
                      size="lg"
                      disabled={start.isPending || missing > 0}
                      onClick={() => start.mutate()}
                      className="game-gradient min-w-48 border-0 text-white shadow-lg shadow-[var(--game-glow)] hover:opacity-95"
                    >
                      <Play className="size-4 fill-current" />
                      {lobby.players.length === 1
                        ? game.verbs.startSolo
                        : game.verbs.start}
                    </Button>
                    {missing > 0 && (
                      <span className="text-xs text-muted-foreground">
                        Waiting for {missing} more{" "}
                        {missing === 1 ? "player" : "players"} — this game needs{" "}
                        {lobby.minPlayers}
                      </span>
                    )}
                  </div>
                ) : me ? (
                  <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                    Waiting for {host ? userLabel(host.user) : "the host"} to
                    start
                    <TypingDots />
                  </span>
                ) : (
                  <Button
                    size="lg"
                    disabled={join.isPending || full}
                    onClick={() => join.mutate()}
                    className="game-gradient min-w-48 border-0 text-white shadow-lg shadow-[var(--game-glow)] hover:opacity-95"
                  >
                    <Swords className="size-4" />
                    {full ? "Lobby full" : game.verbs.join}
                  </Button>
                )}
              </div>
            </GamePanel>
          )}

          {(phase === "countdown" || phase === "racing") && (
            <PlayArea game={game} lobby={lobby} meId={meId} now={now} />
          )}

          {phase === "finished" && (
            <GamePanel
              title="Results"
              icon={Trophy}
              actions={
                isHost ? (
                  <Button
                    disabled={rematch.isPending}
                    onClick={() => rematch.mutate()}
                    className="game-gradient border-0 text-white shadow-md shadow-[var(--game-glow)] hover:opacity-95"
                  >
                    <RotateCcw className="size-4" />
                    Rematch
                  </Button>
                ) : me ? (
                  <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    Waiting for a rematch
                    <TypingDots />
                  </span>
                ) : null
              }
            >
              <ResultsPodium
                players={lobby.players}
                scoreUnit={game.scoreUnit}
                meId={meId}
                raceStats={game.raceStats}
              />
              <div className="flex justify-center pt-2">
                <Button asChild variant="ghost" size="sm">
                  <Link to="/games/$game" params={{ game: gameId }}>
                    <Trophy className="size-4" />
                    See the leaderboard
                  </Link>
                </Button>
              </div>
            </GamePanel>
          )}

          {phase === "finished" && ResultsExtras && (
            <ResultsExtras lobby={lobby} />
          )}
        </div>

        {meId !== undefined && <LobbyChat lobby={lobby} meId={meId} />}
      </div>
      <ReactionStream lobby={lobby} meId={meId} />
    </GameShell>
  );
}
