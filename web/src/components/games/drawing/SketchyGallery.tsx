import { useState, type CSSProperties } from "react";
import { Images, Play } from "lucide-react";
import { GamePanel } from "@/components/games/GamePanel";
import type { GameLobby } from "@/lib/games/lobby";
import type { DrawingEntry } from "@/lib/games/drawing";
import { DrawingView } from "./DrawingView";
import { castLabel, useCast, type Cast } from "@/lib/games/cast";

// Each gallery card sits at its own slight angle, like prints pinned to a
// board; they straighten up under the pointer.
const TILTS = ["-2deg", "1.5deg", "-1deg", "2deg", "-1.5deg", "1deg"];

// The bluff that fooled the most players, if any did.
function bestFake(drawing: DrawingEntry) {
  const fakes = (drawing.answers ?? [])
    .filter(
      (answer) => answer.real === false && (answer.voterIds?.length ?? 0) > 0,
    )
    .sort((a, b) => b.voterIds!.length - a.voterIds!.length);
  return fakes[0] ?? null;
}

// After the podium: every drawing of the game on one wall, each with its
// real prompt and the fake that fooled the most people. Tap one to watch it
// being drawn again.
export function SketchyGallery({ lobby }: { lobby: GameLobby }) {
  const cast = useCast(lobby);
  const drawings = lobby.drawing?.drawings ?? [];
  if (drawings.length === 0) return null;
  return (
    <GamePanel title="Gallery" icon={Images}>
      <ul className="-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-3 pt-1 sm:grid sm:grid-cols-2 sm:overflow-visible lg:grid-cols-3">
        {drawings.map((drawing, index) => (
          <GalleryCard
            key={drawing.id}
            drawing={drawing}
            cast={cast}
            index={index}
          />
        ))}
      </ul>
    </GamePanel>
  );
}

function GalleryCard({
  drawing,
  cast,
  index,
}: {
  drawing: DrawingEntry;
  cast: Cast;
  index: number;
}) {
  // Re-keying the view replays its drawing animation from the top.
  const [replays, setReplays] = useState(0);
  const fake = bestFake(drawing);
  return (
    <li
      style={
        {
          "--stagger-index": index,
          "--deal-tilt": TILTS[index % TILTS.length],
        } as CSSProperties
      }
      className="w-64 shrink-0 snap-center motion-safe:animate-card-deal stagger-in sm:w-auto"
    >
      <figure
        className="group flex flex-col gap-2 rounded-2xl border border-border/50 bg-card/60 p-3 transition-transform duration-500 ease-spring hover:-translate-y-1 hover:rotate-0"
        style={{ rotate: TILTS[index % TILTS.length] }}
      >
        <button
          type="button"
          onClick={() => setReplays((n) => n + 1)}
          className="relative block w-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--game-from)]"
          aria-label={`Replay ${castLabel(cast, drawing.artistId)}'s drawing`}
        >
          <DrawingView
            key={replays}
            strokes={drawing.strokes}
            replayMs={replays > 0 ? 2_400 : undefined}
            label={drawing.prompt ?? "A drawing"}
          />
          <span className="absolute bottom-2 right-2 flex size-8 items-center justify-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur transition-opacity duration-300 group-hover:opacity-100">
            <Play className="size-3.5 fill-current" />
          </span>
        </button>
        <figcaption className="flex flex-col gap-1 px-0.5">
          <span className="text-sm font-semibold leading-snug">
            <span className="game-text">{drawing.prompt}</span>
          </span>
          <span className="text-xs text-muted-foreground">
            by {castLabel(cast, drawing.artistId)}
          </span>
          {fake && (
            <span className="text-xs text-muted-foreground">
              Best fake:{" "}
              <span className="font-medium text-foreground">
                &ldquo;{fake.text}&rdquo;
              </span>{" "}
              — fooled {fake.voterIds!.length}
              {fake.authorId !== null && ` (${castLabel(cast, fake.authorId)})`}
            </span>
          )}
        </figcaption>
      </figure>
    </li>
  );
}
