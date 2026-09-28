import { useMemo, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  BRUSH_WIDTH,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DRAWING_PALETTE,
  replayTimings,
  strokePath,
  type DrawingStroke,
} from "@/lib/games/drawing";

// A drawing, rendered from its strokes at any size. With `replayMs` it
// draws itself stroke by stroke over that long — the pen retracing what the
// artist did, in order — which is how a drawing makes its entrance in the
// bluff stage. Pure CSS (see `animate-stroke-draw`), so it costs nothing
// once it's done and simply shows the finished drawing under reduced motion.
export function DrawingView({
  strokes,
  replayMs,
  label,
  className,
  children,
}: {
  strokes: ReadonlyArray<DrawingStroke> | null;
  /** Replays the drawing over this long; omit to show it finished. */
  replayMs?: number;
  /** Accessible name — the drawing is an image. */
  label: string;
  className?: string;
  /** Overlaid on the paper (e.g. a stamp or a caption). */
  children?: ReactNode;
}) {
  const timings = useMemo(
    () =>
      strokes && replayMs !== undefined
        ? replayTimings(strokes, replayMs)
        : null,
    [strokes, replayMs],
  );
  const blank = strokes !== null && strokes.length === 0;
  // Built once per drawing, not on every tick of the game clock that
  // re-renders the page around it.
  const paths = useMemo(
    () =>
      strokes?.map((stroke, index) => {
        const timing = timings?.[index];
        const isDot = stroke.points.length <= 2;
        return (
          <path
            key={index}
            d={strokePath(stroke.points)}
            stroke={DRAWING_PALETTE[stroke.color]?.value ?? "#000"}
            strokeWidth={BRUSH_WIDTH[stroke.brush]}
            pathLength={isDot ? undefined : 1}
            className={cn(
              timing &&
                (isDot
                  ? "motion-safe:animate-dot-draw"
                  : "motion-safe:animate-stroke-draw"),
            )}
            style={
              timing
                ? ({
                    "--stroke-delay": `${timing.delayMs}ms`,
                    "--stroke-duration": `${Math.max(timing.durationMs, 60)}ms`,
                  } as CSSProperties)
                : undefined
            }
          />
        );
      }),
    [strokes, timings],
  );

  return (
    <div
      className={cn(
        "sketch-paper relative aspect-[4/3] w-full overflow-hidden rounded-xl shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06),0_10px_30px_-12px_rgb(0_0_0/0.45)]",
        className,
      )}
    >
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
        className="absolute inset-0 size-full"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {paths}
      </svg>
      {blank && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-sm font-medium text-stone-400">
          <span className="text-3xl" aria-hidden>
            🫥
          </span>
          A blank canvas
          <span className="text-xs font-normal">
            Time ran out before the artist drew anything
          </span>
        </div>
      )}
      {children}
    </div>
  );
}
