import { createFileRoute } from "@tanstack/react-router";
import { Gamepad2, Radio } from "lucide-react";
import { GameCard } from "@/components/games/GameCard";
import { LoginPrompt } from "@/components/LoginPrompt";
import { GradientText } from "@/components/reactbits/GradientText";
import { useSession } from "@/lib/auth";
import { useGameLobbies } from "@/lib/games/lobby";
import { GAMES } from "@/lib/games/registry";
import { gameHubRoom, useGameRoom } from "@/lib/games/rooms";

export const Route = createFileRoute("/games/")({
  component: ArcadePage,
});

// The typing race's live-activity pill on its hub card: how many lobbies are
// open right now, kept live through the hub room.
function TypingActivity() {
  useGameRoom(gameHubRoom("typing"));
  const { data: lobbies } = useGameLobbies("typing", true);
  if (!lobbies) return null;
  const players = lobbies.reduce((sum, l) => sum + l.players.length, 0);
  return (
    <span
      key={lobbies.length}
      className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_oklch,var(--game-from),transparent_60%)] bg-background/60 px-2.5 py-0.5 text-xs font-medium motion-safe:animate-in motion-safe:zoom-in-90"
    >
      <Radio className="size-3 text-[var(--game-from)] motion-safe:animate-pulse" />
      {lobbies.length === 0
        ? "No open lobbies"
        : `${lobbies.length} ${lobbies.length === 1 ? "lobby" : "lobbies"} · ${players} playing`}
    </span>
  );
}

function ArcadePage() {
  const session = useSession();
  return (
    <main className="relative mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 pb-16 pt-8">
      <div
        aria-hidden
        className="game-grid pointer-events-none absolute inset-x-0 top-0 -z-10 h-80"
      />
      <header className="flex flex-col items-center gap-3 text-center motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2 motion-safe:duration-700">
        <span className="flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-card/70 shadow-lg shadow-primary/20 backdrop-blur">
          <Gamepad2 className="size-7 text-primary motion-safe:animate-float" />
        </span>
        <h1 className="text-4xl font-black tracking-tight sm:text-5xl">
          <GradientText>Arcade</GradientText>
        </h1>
        <p className="max-w-md text-muted-foreground">
          Quick games to play with everyone on the platform. Jump into a lobby,
          race your friends live, and climb the leaderboards.
        </p>
      </header>

      {!session ? (
        <div className="flex justify-center">
          <LoginPrompt
            title="Log in to play"
            description="Games are played against other members — sign in to join a lobby."
          />
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {GAMES.map((game, index) => (
            <GameCard
              key={game.id}
              game={game}
              index={index}
              live={game.id === "typing" ? <TypingActivity /> : undefined}
            />
          ))}
        </div>
      )}
    </main>
  );
}
