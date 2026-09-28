import { Palette, Trophy } from "lucide-react";
import { CountdownOverlay } from "@/components/games/CountdownOverlay";
import { GamePanel } from "@/components/games/GamePanel";
import { useStageAdvance } from "@/lib/games/drawing";
import type { GameLobby } from "@/lib/games/lobby";
import type { GameDefinition } from "@/lib/games/registry";
import { BluffStage } from "./BluffStage";
import { DrawStage } from "./DrawStage";
import { RevealStage } from "./RevealStage";
import { Scoreboard } from "./Scoreboard";
import { useCast } from "@/lib/games/cast";
import { WaitingPencil } from "./shared";
import { StageTimer } from "./StageTimer";
import { StageTrack } from "./StageTrack";
import { VoteStage } from "./VoteStage";

// Sketchy's play area — everything between the countdown and the results
// (the waiting room and podium around it are the shared kit's). The stage
// in progress fills the main panel, sliding in fresh each time it changes;
// the running scores sit alongside.
export function SketchyGame({
  lobby,
  meId,
  now,
}: {
  game: GameDefinition;
  lobby: GameLobby;
  meId: number | undefined;
  now: number;
}) {
  const cast = useCast(lobby);
  useStageAdvance(lobby, now);
  const game = lobby.drawing!;
  const stage = game.stage;
  const spotlight =
    stage?.drawingId != null
      ? game.drawings.find((drawing) => drawing.id === stage.drawingId)
      : undefined;
  const inRound = stage
    ? game.drawings.filter((drawing) => drawing.turn === stage.turn)
    : [];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem] lg:items-start">
      <GamePanel className="relative min-h-80 gap-5" live={!!stage}>
        <CountdownOverlay
          startsAt={lobby.startsAt ?? now}
          now={now}
          hint="Your secret prompt arrives at zero"
        />
        {stage ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <StageTrack kind={stage.kind} />
              <span className="text-xs text-muted-foreground">
                Round {stage.turn} of {game.rounds}
                {spotlight && (
                  <>
                    {" · "}Drawing {spotlight.position + 1} of {inRound.length}
                  </>
                )}
              </span>
              <StageTimer
                startedAt={stage.startedAt}
                endsAt={stage.endsAt}
                now={now}
                urgency={stage.kind !== "reveal"}
                className="ml-auto"
              />
            </div>
            <div
              key={`${stage.kind}:${stage.turn}:${stage.drawingId}`}
              className="motion-safe:animate-stage-enter"
            >
              {stage.kind === "draw" && (
                <DrawStage
                  lobbyId={lobby.id}
                  lobbyRound={lobby.round}
                  game={game}
                  stage={stage}
                  cast={cast}
                  meId={meId}
                  now={now}
                />
              )}
              {stage.kind === "bluff" && spotlight && (
                <BluffStage
                  lobbyId={lobby.id}
                  game={game}
                  drawing={spotlight}
                  cast={cast}
                  meId={meId}
                />
              )}
              {stage.kind === "vote" && spotlight && (
                <VoteStage
                  lobbyId={lobby.id}
                  game={game}
                  drawing={spotlight}
                  cast={cast}
                  meId={meId}
                />
              )}
              {stage.kind === "reveal" && spotlight && (
                <RevealStage
                  drawing={spotlight}
                  cast={cast}
                  meId={meId}
                  now={now}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
            <Palette className="size-10 text-[var(--game-from)] motion-safe:animate-doodle-wobble" />
            <p className="text-lg font-semibold">Sharpen your pencils</p>
            <WaitingPencil>
              {game.rounds} {game.rounds === 1 ? "round" : "rounds"} ·{" "}
              {game.participantIds.length} artists
            </WaitingPencil>
          </div>
        )}
      </GamePanel>

      <GamePanel title="Scores" icon={Trophy}>
        <Scoreboard scores={game.scores} cast={cast} meId={meId} />
      </GamePanel>
    </div>
  );
}
