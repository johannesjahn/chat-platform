import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import { Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BRUSH_WIDTH,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DRAWING_PALETTE,
  MAX_POINTS,
  MAX_STROKES,
  MIN_POINT_GAP,
  pointCount,
  strokePath,
  type DrawingBrush,
  type DrawingStroke,
} from "@/lib/games/drawing";

type Point = { x: number; y: number };

const clamp = (value: number, max: number) =>
  Math.min(Math.max(Math.round(value), 0), max);

// Where a pointer event lands on the virtual canvas, whatever size the
// canvas is rendered at.
function toCanvas(event: PointerEvent, rect: DOMRect): Point {
  return {
    x: clamp(
      ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      CANVAS_WIDTH,
    ),
    y: clamp(
      ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
      CANVAS_HEIGHT,
    ),
  };
}

// Below this share of ink left, the meter starts warning.
const LOW_INK = 0.15;

// Whether a key press belongs to a text field (or other editable element),
// whose own shortcuts — Ctrl/⌘+Z included — must be left alone.
const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT");

export type SketchCanvasHandle = {
  /** Ends any stroke still being drawn — committing it like a pointer-up —
   * and returns the drawing including it. For sending the drawing when
   * time runs out mid-stroke. */
  flush: () => DrawingStroke[];
};

// The drawing surface for the draw stage. Works the same with a mouse, a
// finger, or a pen — it's all Pointer Events, with the browser's coalesced
// samples folded in so fast strokes stay smooth — and at any width down to
// a phone's. While a stroke is in progress only that one path re-renders
// (once per animation frame); finished strokes go to `onChange`. The brush
// cursor never re-renders at all — it follows the pointer by moving its
// circle directly, once per frame. Memoized, so the game clock ticking the
// page around it doesn't re-render it either (pass a stable `onChange`).
//
// Undo walks back through every change, a "clear" included, so wiping the
// canvas by accident is one tap (or Ctrl/⌘+Z) from undone.
export const SketchCanvas = memo(function SketchCanvas({
  strokes,
  onChange,
  disabled = false,
  handle,
}: {
  strokes: DrawingStroke[];
  onChange: (strokes: DrawingStroke[]) => void;
  disabled?: boolean;
  handle?: Ref<SketchCanvasHandle>;
}) {
  const [color, setColor] = useState(0);
  const [brush, setBrush] = useState<DrawingBrush>("thin");
  const [draft, setDraft] = useState<DrawingStroke | null>(null);
  // Where the brush cursor should be drawn (null: hidden), applied to
  // `cursorRef`'s circle on the next frame.
  const cursorRef = useRef<SVGCircleElement>(null);
  const cursorAt = useRef<Point | null>(null);
  const cursorFrame = useRef(0);
  // Bumped each time a stroke runs dry, to replay the meter's shake.
  const [inkOut, setInkOut] = useState(0);

  // Every earlier version of the drawing, newest last.
  const [history, setHistory] = useState<DrawingStroke[][]>([]);
  const active = useRef<{
    pointerId: number;
    stroke: DrawingStroke;
    last: Point;
  } | null>(null);
  const frame = useRef(0);

  const used = pointCount(strokes) + (draft ? draft.points.length / 2 : 0);
  const inkLeft = Math.max(0, 1 - used / MAX_POINTS);

  const commit = useCallback(
    (next: DrawingStroke[]) => {
      setHistory((past) => [...past, strokes]);
      onChange(next);
    },
    [strokes, onChange],
  );

  const undo = useCallback(() => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((past) => past.slice(0, -1));
    onChange(previous);
  }, [history, onChange]);

  // Ctrl/⌘+Z, while there's something to undo and drawing is allowed —
  // but not while typing somewhere else on the page (the lobby chat), where
  // it's that field's own undo.
  useEffect(() => {
    if (disabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, undo]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      cancelAnimationFrame(cursorFrame.current);
    },
    [],
  );

  const moveCursor = (point: Point | null) => {
    cursorAt.current = point;
    if (cursorFrame.current) return;
    cursorFrame.current = requestAnimationFrame(() => {
      cursorFrame.current = 0;
      const circle = cursorRef.current;
      if (!circle) return;
      const at = cursorAt.current;
      circle.setAttribute("visibility", at ? "visible" : "hidden");
      if (at) {
        circle.setAttribute("cx", String(at.x));
        circle.setAttribute("cy", String(at.y));
      }
    });
  };

  const scheduleDraw = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const current = active.current;
      setDraft(
        current
          ? { ...current.stroke, points: [...current.stroke.points] }
          : null,
      );
    });
  };

  // Ends the stroke in progress, if any; returns the drawing as it now is.
  const finish = (): DrawingStroke[] => {
    const current = active.current;
    active.current = null;
    cancelAnimationFrame(frame.current);
    setDraft(null);
    if (current && current.stroke.points.length >= 2) {
      const next = [...strokes, current.stroke];
      commit(next);
      return next;
    }
    return strokes;
  };

  useImperativeHandle(handle, () => ({ flush: finish }));

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    // One pen at a time — a resting palm or a second finger is ignored.
    if (disabled || active.current || event.button > 0) return;
    if (strokes.length >= MAX_STROKES || used >= MAX_POINTS) {
      setInkOut((n) => n + 1);
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toCanvas(
      event.nativeEvent,
      event.currentTarget.getBoundingClientRect(),
    );
    active.current = {
      pointerId: event.pointerId,
      stroke: { color, brush, points: [point.x, point.y] },
      last: point,
    };
    scheduleDraw();
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.pointerType !== "touch" && !disabled) {
      moveCursor(toCanvas(event.nativeEvent, rect));
    }
    const current = active.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    let budget =
      MAX_POINTS - pointCount(strokes) - current.stroke.points.length / 2;
    for (const sample of samples.length > 0 ? samples : [event.nativeEvent]) {
      const point = toCanvas(sample, rect);
      if (
        Math.hypot(point.x - current.last.x, point.y - current.last.y) <
        MIN_POINT_GAP
      ) {
        continue;
      }
      if (budget <= 0) {
        setInkOut((n) => n + 1);
        finish();
        return;
      }
      current.stroke.points.push(point.x, point.y);
      current.last = point;
      budget--;
    }
    scheduleDraw();
  };

  const lowInk = inkLeft < LOW_INK;
  // The finished strokes only change when a stroke is committed — not on
  // every frame of the one being drawn, nor every tick of the game clock.
  const committed = useMemo(
    () =>
      strokes.map((stroke, index) => (
        <path
          key={index}
          d={strokePath(stroke.points)}
          stroke={DRAWING_PALETTE[stroke.color]!.value}
          strokeWidth={BRUSH_WIDTH[stroke.brush]}
        />
      )),
    [strokes],
  );

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "sketch-paper relative mx-auto aspect-[4/3] w-full overflow-hidden rounded-2xl xl:max-w-[calc(72svh*4/3)] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.06),0_18px_50px_-20px_var(--game-glow)] transition-[filter,opacity] duration-500",
          disabled && "opacity-80 saturate-50",
        )}
      >
        <svg
          role="img"
          aria-label="Your drawing"
          viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
          className={cn(
            "absolute inset-0 size-full touch-none select-none",
            disabled ? "cursor-not-allowed" : "cursor-none",
          )}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          onPointerLeave={() => moveCursor(null)}
        >
          {committed}
          {draft && (
            <path
              d={strokePath(draft.points)}
              stroke={DRAWING_PALETTE[draft.color]!.value}
              strokeWidth={BRUSH_WIDTH[draft.brush]}
            />
          )}
          {/* The brush itself, following a mouse or pen: its size and color
              exactly, so what you see is what you'll draw. */}
          {!disabled && (
            <circle
              ref={cursorRef}
              // Constant props, so re-renders never undo `moveCursor`'s
              // direct updates; it starts hidden until the pointer moves.
              visibility="hidden"
              cx={0}
              cy={0}
              r={BRUSH_WIDTH[brush] / 2}
              fill={DRAWING_PALETTE[color]!.value}
              fillOpacity={0.35}
              stroke="#1d1b26"
              strokeOpacity={0.5}
              strokeWidth={1.5}
              className="pointer-events-none"
            />
          )}
        </svg>
        {strokes.length === 0 && !draft && !disabled && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-medium text-stone-400 motion-safe:animate-in motion-safe:fade-in-0">
            Draw here — mouse, finger, or pen
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div
          role="radiogroup"
          aria-label="Color"
          className="flex flex-wrap items-center gap-1.5"
        >
          {DRAWING_PALETTE.map((swatch, index) => (
            <button
              key={swatch.name}
              type="button"
              role="radio"
              aria-checked={color === index}
              aria-label={swatch.name}
              title={swatch.name}
              disabled={disabled}
              onClick={() => setColor(index)}
              style={{ "--swatch": swatch.value } as CSSProperties}
              className={cn(
                "size-6 rounded-full bg-[var(--swatch)] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.18)] transition-transform duration-300 ease-spring hover:scale-110 disabled:opacity-50 sm:size-8",
                color === index &&
                  "scale-115 ring-2 ring-[var(--game-from)] ring-offset-2 ring-offset-background motion-safe:animate-like-pop",
              )}
            />
          ))}
        </div>

        <div
          role="radiogroup"
          aria-label="Brush size"
          className="inline-flex rounded-full border border-border/70 bg-background/50 p-0.5"
        >
          {(["thin", "thick"] as const).map((size) => (
            <button
              key={size}
              type="button"
              role="radio"
              aria-checked={brush === size}
              aria-label={size === "thin" ? "Thin brush" : "Thick brush"}
              disabled={disabled}
              onClick={() => setBrush(size)}
              className={cn(
                "flex size-9 items-center justify-center rounded-full transition-colors duration-200",
                brush === size
                  ? "game-gradient text-white shadow-md shadow-[var(--game-glow)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span
                className="rounded-full bg-current transition-transform duration-300 ease-spring"
                style={{
                  width: size === "thin" ? 5 : 13,
                  height: size === "thin" ? 5 : 13,
                }}
              />
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || history.length === 0}
            onClick={undo}
            aria-keyshortcuts="Control+Z Meta+Z"
          >
            <Undo2 className="size-4" />
            Undo
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || strokes.length === 0}
            onClick={() => commit([])}
          >
            <Trash2 className="size-4" />
            Clear
          </Button>
        </div>
      </div>

      <div
        key={inkOut}
        className={cn(
          "flex items-center gap-2 text-xs text-muted-foreground",
          inkOut > 0 && "motion-safe:animate-shake",
        )}
      >
        <span className="shrink-0 font-medium">Ink</span>
        <div
          role="meter"
          aria-label="Ink left"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(inkLeft * 100)}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300",
              lowInk
                ? "bg-destructive motion-safe:animate-ink-low"
                : "game-gradient",
            )}
            style={{ width: `${inkLeft * 100}%` }}
          />
        </div>
        <span
          className={cn(
            "w-9 text-right tabular-nums",
            lowInk && "text-destructive",
          )}
        >
          {Math.round(inkLeft * 100)}%
        </span>
      </div>
    </div>
  );
});
