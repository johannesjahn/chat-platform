import { useCallback, useEffect, useMemo, useRef } from "react";
import { gsap } from "gsap";

import { cn } from "@/lib/utils";

// Interactive dot field adapted from reactbits' DotGrid. Dots light up near the
// pointer and get pushed outward on click, then spring back into place. The
// upstream component relies on GSAP's paid InertiaPlugin for the throw-back; we
// keep the same look using the free gsap core with an elastic ease instead.

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

type Dot = {
  cx: number;
  cy: number;
  xOffset: number;
  yOffset: number;
  _inertiaApplied: boolean;
};

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
          _inertiaApplied: false,
        });
      }
    }
    dotsRef.current = dots;
  }, [dotSize, gap]);

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
    let raf = 0;

    const draw = () => {
      const { width, height } = canvas;
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, width / dpr, height / dpr);
      const { x: px, y: py } = pointerRef.current;

      for (const dot of dotsRef.current) {
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
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [activeRgb, baseRgb, dotSize, proximity]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      pointerRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    };

    const onLeave = () => {
      pointerRef.current = { x: -1000, y: -1000 };
    };

    const onClick = (e: MouseEvent) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      for (const dot of dotsRef.current) {
        const dx = dot.cx - cx;
        const dy = dot.cy - cy;
        const dist = Math.hypot(dx, dy);
        if (dist >= shockRadius) continue;
        const falloff = 1 - dist / shockRadius;
        const push = falloff * shockStrength * 12;
        const angle = Math.atan2(dy, dx);
        gsap.killTweensOf(dot);
        gsap.to(dot, {
          xOffset: Math.cos(angle) * push,
          yOffset: Math.sin(angle) * push,
          duration: 0.18,
          ease: "power2.out",
          onComplete: () => {
            gsap.to(dot, {
              xOffset: 0,
              yOffset: 0,
              duration: returnDuration,
              ease: "elastic.out(1, 0.5)",
            });
          },
        });
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
  }, [returnDuration, shockRadius, shockStrength]);

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
