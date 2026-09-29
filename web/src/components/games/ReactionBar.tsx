import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  flingGameReaction,
  GAME_REACTIONS,
  type GameReaction,
} from "@/lib/games/reactions";

// A row of emoji anyone watching the lobby can tap to fling one across every
// screen in it (see ReactionStream). Works in every phase — including the
// middle of a game, where it's the one way to cheer that can't leak anything.
export function ReactionBar({
  lobbyId,
  meId,
  className,
}: {
  lobbyId: number;
  meId: number;
  className?: string;
}) {
  // Remounts the tapped emoji so its pop replays on every tap.
  const [popped, setPopped] = useState<{ reaction: string; n: number }>({
    reaction: "",
    n: 0,
  });
  const fling = (reaction: GameReaction) => {
    flingGameReaction(lobbyId, meId, reaction);
    setPopped((prev) => ({ reaction, n: prev.n + 1 }));
  };

  return (
    <div
      role="group"
      aria-label="Send a reaction"
      className={cn("flex flex-wrap items-center gap-1", className)}
    >
      {GAME_REACTIONS.map((reaction) => (
        <button
          key={reaction}
          type="button"
          aria-label={`React ${reaction}`}
          // Keep focus where it was — mid-race, that's the typing box.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => fling(reaction)}
          className="flex size-8 items-center justify-center rounded-full text-lg transition-transform hover:scale-115 hover:bg-[color-mix(in_oklch,var(--game-from),transparent_85%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--game-from)] active:scale-95"
        >
          <span
            key={popped.reaction === reaction ? popped.n : 0}
            className="motion-safe:animate-emoji-pop"
          >
            {reaction}
          </span>
        </button>
      ))}
    </div>
  );
}
