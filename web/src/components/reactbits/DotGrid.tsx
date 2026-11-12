import { useCallback, useEffect, useMemo, useRef } from "react";

import { cn } from "@/lib/utils";

// Interactive dot field adapted from reactbits' DotGrid. Dots light up near the
// pointer and get pushed outward on click, then spring back into place. The
// upstream component relies on GSAP's paid InertiaPlugin for the throw-back; we
// keep the same look with a quick ease-out push and an elastic spring back,
// tweened here in the draw loop rather than through GSAP (issue #754: GSAP
// was most of the login page's 30 kB gzip chunk, for just these two eases).
//
// Frames are only drawn when something changed — the pointer moved, a click's
// shock wave is still springing back, or the grid was rebuilt — rather than in
// a loop that redrew every dot 60 times a second for as long as the page sat
// open.

export type DotGridProps = {
  dotSize?: number;
  gap?: number;
  baseColor?: string;
  activeColor?: string;
  proximity?: number;
  shockRadius?: number;
  shockStrength?: number;
  returnDuration?: number;
  className?: string;
  style?: React.CSSProperties;
};

// A click's push-out from where the dot was (`fromX/Y`) to `pushX/Y`, then
// the spring back to rest, timed from `start` (a `performance.now()`).
type Shock = {
  start: number;
  fromX: number;
  fromY: number;
  pushX: number;
  pushY: number;
};

type Dot = {
  cx: number;
  cy: number;
  xOffset: number;
  yOffset: number;
  shock: Shock | null;
};

const PUSH_DURATION_MS = 180;

// GSAP's `power2.out`.
const easeOutQuad = (p: number) => 1 - (1 - p) * (1 - p);

// GSAP's `elastic.out(1, 0.5)`: 0 at the start, overshooting 1 with a
// decaying wobble, settled at 1.
const ELASTIC_PERIOD = 0.5;
const ELASTIC_PHASE = (ELASTIC_PERIOD / (2 * Math.PI)) * Math.asin(1);
function easeOutElastic(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return (
    2 ** (-10 * p) *
      Math.sin(((p - ELASTIC_PHASE) * (2 * Math.PI)) / ELASTIC_PERIOD) +
    1
  );
}

// Moves a dot along its shock at `now`, clearing it once it's back at rest.
function advanceShock(dot: Dot, now: number, returnMs: number) {
  const shock = dot.shock;
  if (!shock) return;
  const elapsed = now - shock.start;
  if (elapsed < PUSH_DURATION_MS) {
    const t = easeOutQuad(Math.max(0, elapsed) / PUSH_DURATION_MS);
    dot.xOffset = shock.fromX + (shock.pushX - shock.fromX) * t;
    dot.yOffset = shock.fromY + (shock.pushY - shock.fromY) * t;
    return;
  }
  const p = (elapsed - PUSH_DURATION_MS) / returnMs;
  if (p >= 1) {
    dot.xOffset = 0;
    dot.yOffset = 0;
    dot.shock = null;
    return;
  }
  const back = 1 - easeOutElastic(p);
  dot.xOffset = shock.pushX * back;
  dot.yOffset = shock.pushY * back;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

export function DotGrid({
  dotSize = 4,
  gap = 28,
  baseColor = "#2a2f3a",
  activeColor = "#6366f1",
  proximity = 120,
  shockRadius = 220,
  shockStrength = 4,
  returnDuration = 1.4,
  className,
  style,
}: DotGridProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dotsRef = useRef<Dot[]>([]);
  const pointerRef = useRef({ x: -1000, y: -1000 });
  // The current frame painter, the pending frame, and until when (a click's
  // tweens) frames should keep coming without further input.
  const drawRef = useRef<(() => void) | null>(null);
  const frameRef = useRef(0);
  const animateUntilRef = useRef(0);

  const requestDraw = useCallback(() => {
    if (frameRef.current) return;
    const tick = () => {
      frameRef.current = 0;
      drawRef.current?.();
      if (performance.now() < animateUntilRef.current) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };
    frameRef.current = requestAnimationFrame(tick);
  }, []);

  const baseRgb = useMemo(() => hexToRgb(baseColor), [baseColor]);
  const activeRgb = useMemo(() => hexToRgb(activeColor), [activeColor]);

  const buildGrid = useCallback(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas) return;

    const { width, height } = wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    ctx?.scale(dpr, dpr);

    const cell = dotSize + gap;
    const cols = Math.floor((width + gap) / cell);
    const rows = Math.floor((height + gap) / cell);
    const gridW = cols * cell - gap;
    const gridH = rows * cell - gap;
    const startX = (width - gridW) / 2 + dotSize / 2;
    const startY = (height - gridH) / 2 + dotSize / 2;

    const dots: Dot[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        dots.push({
          cx: startX + x * cell,
          cy: startY + y * cell,
          xOffset: 0,
          yOffset: 0,
          shock: null,
        });
      }
    }
    dotsRef.current = dots;
    requestDraw();
  }, [dotSize, gap, requestDraw]);

  useEffect(() => {
    buildGrid();
    const ro = new ResizeObserver(buildGrid);
    if (wrapperRef.current) ro.observe(wrapperRef.current);
    return () => ro.disconnect();
  }, [buildGrid]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const proxSq = proximity * proximity;
    const returnMs = returnDuration * 1000;

    drawRef.current = () => {
      const { width, height } = canvas;
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, width / dpr, height / dpr);
      const { x: px, y: py } = pointerRef.current;
      const now = performance.now();

      for (const dot of dotsRef.current) {
        advanceShock(dot, now, returnMs);
        const ox = dot.cx + dot.xOffset;
        const oy = dot.cy + dot.yOffset;
        const dx = ox - px;
        const dy = oy - py;
        const dsq = dx * dx + dy * dy;

        let color = baseRgb;
        if (dsq <= proxSq) {
          const t = 1 - Math.sqrt(dsq) / proximity;
          color = {
            r: Math.round(baseRgb.r + (activeRgb.r - baseRgb.r) * t),
            g: Math.round(baseRgb.g + (activeRgb.g - baseRgb.g) * t),
            b: Math.round(baseRgb.b + (activeRgb.b - baseRgb.b) * t),
          };
        }

        ctx.beginPath();
        ctx.arc(ox, oy, dotSize / 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${color.r},${color.g},${color.b})`;
        ctx.fill();
      }
    };
    requestDraw();
    return () => {
      drawRef.current = null;
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [activeRgb, baseRgb, dotSize, proximity, requestDraw, returnDuration]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      pointerRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      requestDraw();
    };

    const onLeave = () => {
      pointerRef.current = { x: -1000, y: -1000 };
      requestDraw();
    };

    const onClick = (e: MouseEvent) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const now = performance.now();
      // Keep drawing through the push-out and the spring back.
      animateUntilRef.current = Math.max(
        animateUntilRef.current,
        now + PUSH_DURATION_MS + returnDuration * 1000 + 100,
      );
      requestDraw();
      for (const dot of dotsRef.current) {
        const dx = dot.cx - cx;
        const dy = dot.cy - cy;
        const dist = Math.hypot(dx, dy);
        if (dist >= shockRadius) continue;
        const falloff = 1 - dist / shockRadius;
        const push = falloff * shockStrength * 12;
        const angle = Math.atan2(dy, dx);
        // A new click takes over from wherever the dot is mid-spring.
        dot.shock = {
          start: now,
          fromX: dot.xOffset,
          fromY: dot.yOffset,
          pushX: Math.cos(angle) * push,
          pushY: Math.sin(angle) * push,
        };
      }
    };

    const wrapper = wrapperRef.current;
    window.addEventListener("mousemove", onMove);
    wrapper?.addEventListener("mouseleave", onLeave);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("mousemove", onMove);
      wrapper?.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("click", onClick);
    };
  }, [requestDraw, returnDuration, shockRadius, shockStrength]);

  return (
    <div
      ref={wrapperRef}
      className={cn("pointer-events-none absolute inset-0", className)}
      style={style}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}

export default DotGrid;
