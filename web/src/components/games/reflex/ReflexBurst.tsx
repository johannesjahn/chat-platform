import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

export type ReflexBurstHandle = {
  /** Sparks flying out of (x, y) — fractions of the canvas — in `colors`. */
  burst: (
    x: number,
    y: number,
    options?: {
      colors?: ReadonlyArray<string>;
      count?: number;
      power?: number;
    },
  ) => void;
};

type Spark = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  // Streaks are drawn as short lines along their velocity; the rest as
  // glowing dots.
  streak: boolean;
};

const GRAVITY = 900;
const DRAG = 2.6;

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// A canvas over the arena for the effects CSS can't do cheaply — dozens of
// sparks with real physics when a hit lands. The frame loop only runs while
// sparks are alive, so an idle arena costs nothing. Nothing at all under
// reduced motion.
export function ReflexBurst({ ref }: { ref: Ref<ReflexBurstHandle> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sparks = useRef<Spark[]>([]);
  const frame = useRef(0);
  const lastAt = useRef(0);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const draw = (at: number) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const dt = Math.min((at - lastAt.current) / 1000, 0.05);
    lastAt.current = at;
    const { width, height } = canvas;
    context.clearRect(0, 0, width, height);
    context.globalCompositeOperation = "lighter";
    const scale = window.devicePixelRatio || 1;
    sparks.current = sparks.current.filter((spark) => {
      spark.life -= dt;
      if (spark.life <= 0) return false;
      spark.vx -= spark.vx * DRAG * dt;
      spark.vy += GRAVITY * dt * (spark.streak ? 0.35 : 1);
      spark.vy -= spark.vy * DRAG * dt;
      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
      const fade = spark.life / spark.maxLife;
      context.globalAlpha = Math.min(1, fade * 1.4);
      context.fillStyle = spark.color;
      context.strokeStyle = spark.color;
      if (spark.streak) {
        context.lineWidth = spark.size * scale;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(spark.x * scale, spark.y * scale);
        context.lineTo(
          (spark.x - spark.vx * 0.04) * scale,
          (spark.y - spark.vy * 0.04) * scale,
        );
        context.stroke();
      } else {
        context.beginPath();
        context.arc(
          spark.x * scale,
          spark.y * scale,
          spark.size * fade * scale,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
      return true;
    });
    context.globalAlpha = 1;
    if (sparks.current.length > 0) {
      frame.current = requestAnimationFrame(draw);
    } else {
      frame.current = 0;
      context.clearRect(0, 0, width, height);
    }
  };

  useImperativeHandle(ref, () => ({
    burst: (x, y, { colors = ["#fff"], count = 48, power = 1 } = {}) => {
      const canvas = canvasRef.current;
      if (!canvas || prefersReducedMotion()) return;
      // Size the backing store to the element each burst: the arena
      // resizes with the page, and bursts are rare.
      const rect = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * scale);
      canvas.height = Math.round(rect.height * scale);
      const originX = x * rect.width;
      const originY = y * rect.height;
      const reach = Math.max(rect.width, 320) * power;
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = reach * (0.35 + Math.random() * 1.1);
        const maxLife = 0.5 + Math.random() * 0.7;
        sparks.current.push({
          x: originX,
          y: originY,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - reach * 0.25,
          life: maxLife,
          maxLife,
          size: 1.5 + Math.random() * 3,
          color: colors[i % colors.length]!,
          streak: i % 3 === 0,
        });
      }
      if (!frame.current) {
        lastAt.current = performance.now();
        frame.current = requestAnimationFrame(draw);
      }
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-30 size-full"
    />
  );
}
