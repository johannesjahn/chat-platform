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
import { LobbySeats } from "@/components/games/LobbySeats";
import { PhaseBadge } from "@/components/games/PhaseBadge";
import { ResultsPodium } from "@/components/games/ResultsPodium";
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
  useServerClock,
  type GameLobby,
} from "@/lib/games/lobby";
import {
  GAMES,
  getGame,
  type GameDefinition,
  type GameId,
} from "@/lib/games/registry";
import { gameLobbyRoom, useGameRoom } from "@/lib/games/rooms";
import { userLabel } from "@/lib/users";

export const Route = createFileRoute("/games/$game/$lobbyId")({
  component: LobbyRoute,
});

type PlayAreaProps = {
  game: GameDefinition;
  lobby: GameLobby;
  meId: number | undefined;
  now: number;
};

// The only per-game piece of a lobby page: what's on screen while the race
// runs. Everything around it — waiting room, countdown, results, rematch —
// is shared. A new game registers its play area here.
const PLAY_AREAS: Record<GameId, ComponentType<PlayAreaProps>> = {
  typing: TypingRace,
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
        />
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

  // The race can end on the clock (time limit) with no event to say so —
  // refetch to pick up the server's final word the moment it does.
  useEffect(() => {
    if (phase === "finished" && serverPhase !== "finished") {
      void queryClient.invalidateQueries({
        queryKey: gameLobbyQueryKey(lobbyId),
      });
    }
  }, [phase, serverPhase, lobbyId, queryClient]);

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
          description="Sign in to race — or watch — with everyone here."
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
          description="Everyone left, or the link is wrong. Find another race in the lobby browser."
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
  const PlayArea = PLAY_AREAS[gameId];
  const won =
    phase === "finished" && me?.place === 1 && lobby.players.length > 1;

  return (
    <GameShell
      game={game}
      back={{ game: gameId, label: game.name }}
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
              <Check className="size-4 text-emerald-400 motion-safe:animate-like-pop" />
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
              Share the invite link to fill the seats
            </span>
          }
        >
          <LobbySeats lobby={lobby} meId={meId} />
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            {isHost ? (
              <Button
                size="lg"
                disabled={start.isPending}
                onClick={() => start.mutate()}
                className="game-gradient min-w-48 border-0 text-white shadow-lg shadow-[var(--game-glow)] hover:opacity-95"
              >
                <Play className="size-4 fill-current" />
                {lobby.players.length === 1 ? "Start solo race" : "Start race"}
              </Button>
            ) : me ? (
              <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                Waiting for {host ? userLabel(host.user) : "the host"} to start
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
                {full ? "Lobby full" : "Join the race"}
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
    </GameShell>
  );
}
