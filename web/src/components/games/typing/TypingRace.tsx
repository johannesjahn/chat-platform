import { useCallback, useEffect, useRef, type CSSProperties } from "react";
import { Flag, Gauge, Target, Timer } from "lucide-react";
import { errorMessage } from "@/lib/errors";
import {
  formatDuration,
  ordinal,
  useFinishRace,
  type GameLobby,
} from "@/lib/games/lobby";
import type { GameDefinition } from "@/lib/games/registry";
import { gameProgressOf, useGameProgressVersion } from "@/lib/games/rooms";
import { useTypingRace, wordsPerMinute } from "@/lib/games/typing";
import { CountdownOverlay } from "../CountdownOverlay";
import { GamePanel } from "../GamePanel";
import { GameStat } from "../GameStat";
import { PlayerLane } from "../PlayerLane";
import { TypingPassage } from "./TypingPassage";

// The typing race's play area — the one game-specific piece of a lobby page
// (the waiting room and results around it are shared, see the lobby route).
// The racer's own passage and live stats on top, every racer's lane below,
// all under the countdown overlay until the start.
export function TypingRace({
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
  const passage = lobby.passage ?? "";
  const startsAt = lobby.startsAt ?? now;
  const me = lobby.players.find((player) => player.user.id === meId);
  const racing = now >= startsAt && (lobby.endsAt ?? 0) > now;
  const iFinished = me?.place != null;
  const canType = !!me && racing && !iFinished;

  const finish = useFinishRace(lobby.id, "typing");
  const { mutate: submitFinish } = finish;
  const onFinish = useCallback(
    (typed: string, errors: number) => submitFinish({ typed, errors }),
    [submitFinish],
  );
  const { state, handleInput } = useTypingRace({
    lobbyId: lobby.id,
    passage,
    enabled: canType,
    onFinish,
  });

  // Straight into the passage the moment typing unlocks.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (canType) inputRef.current?.focus();
  }, [canType]);

  useGameProgressVersion();
  const elapsed = Math.max(0, now - startsAt);
  const liveWpm = wordsPerMinute(state.correct, elapsed);
  const progressPercent =
    passage.length === 0
      ? 0
      : (Math.min(state.correct, passage.length) / passage.length) * 100;
  const accuracy =
    state.typed.length === 0
      ? 100
      : (state.correct / (state.correct + state.errors)) * 100;

  return (
    <div className="flex flex-col gap-4">
      {me && (
        <GamePanel className="relative gap-5" live={canType}>
          <CountdownOverlay startsAt={startsAt} now={now} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <GameStat
              label={
                <span className="inline-flex items-center gap-1">
                  <Gauge className="size-3.5" />
                  Speed
                </span>
              }
              value={iFinished ? (me.score ?? 0) : liveWpm}
              // Live values change several times a second — shown as-is;
              // only the final result rolls up (GameStat's CountUp).
              display={iFinished ? undefined : Math.round(liveWpm)}
              unit={game.scoreUnit}
              emphasis
            />
            <GameStat
              label={
                <span className="inline-flex items-center gap-1">
                  <Target className="size-3.5" />
                  Accuracy
                </span>
              }
              value={iFinished ? (me.accuracy ?? 0) : accuracy}
              display={iFinished ? undefined : Math.round(accuracy)}
              unit="%"
              decimals={iFinished ? 1 : 0}
              style={{ "--stagger-index": 1 } as CSSProperties}
            />
            <GameStat
              label={
                <span className="inline-flex items-center gap-1">
                  <Timer className="size-3.5" />
                  Time
                </span>
              }
              value={null}
              display={formatDuration(
                iFinished ? (me.durationMs ?? 0) : elapsed,
              )}
              className="hidden sm:flex"
              style={{ "--stagger-index": 2 } as CSSProperties}
            />
            <GameStat
              label={
                <span className="inline-flex items-center gap-1">
                  <Flag className="size-3.5" />
                  Progress
                </span>
              }
              value={progressPercent}
              display={Math.round(progressPercent)}
              unit="%"
              className="hidden sm:flex"
              style={{ "--stagger-index": 3 } as CSSProperties}
            />
          </div>

          {iFinished ? (
            <div className="flex flex-col items-center gap-1 rounded-2xl border border-border/60 bg-background/50 px-6 py-8 text-center motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95">
              <span className="text-sm font-semibold uppercase tracking-[0.25em] text-muted-foreground">
                Finished
              </span>
              <span className="game-text text-5xl font-black">
                {ordinal(me.place!)}
              </span>
              <span className="text-sm text-muted-foreground">
                {Math.round(me.score ?? 0)} {game.scoreUnit} ·{" "}
                {me.accuracy?.toFixed(1)}% accuracy ·{" "}
                {formatDuration(me.durationMs ?? 0)}
              </span>
            </div>
          ) : (
            <TypingPassage
              passage={passage}
              typed={state.typed}
              correct={state.correct}
              errors={state.errors}
              active={canType}
              onInput={handleInput}
              inputRef={inputRef}
            />
          )}
          {finish.error && (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage(finish.error)}
            </p>
          )}
        </GamePanel>
      )}

      <GamePanel title="Track" icon={Flag} className="relative">
        {!me && <CountdownOverlay startsAt={startsAt} now={now} />}
        <div className="flex flex-col gap-2">
          {lobby.players.map((player, index) => {
            const isMe = player.user.id === meId;
            const finished = player.place !== null;
            const chars = finished
              ? passage.length
              : isMe
                ? state.correct
                : gameProgressOf(lobby.id, player.user.id);
            return (
              <PlayerLane
                key={player.user.id}
                user={player.user}
                progress={passage.length === 0 ? 0 : chars / passage.length}
                score={
                  finished
                    ? player.score
                    : now < startsAt
                      ? null
                      : wordsPerMinute(chars, elapsed)
                }
                scoreUnit={game.scoreUnit}
                place={player.place}
                isMe={isMe}
                isHost={player.user.id === lobby.hostId}
                index={index}
              />
            );
          })}
        </div>
      </GamePanel>
    </div>
  );
}
