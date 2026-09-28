import { useId } from "react";
import { cn } from "@/lib/utils";

const RADIUS = 20;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
// The ring turns urgent (red, heartbeat) for the last this-many seconds.
const URGENT_SECONDS = 10;

// A stage's time left as a draining ring around the seconds remaining —
// in the game's gradient, turning red and pulsing near the end. Driven by
// the (server-corrected) clock, so every player's ring agrees.
export function StageTimer({
  startedAt,
  endsAt,
  now,
  urgency = true,
  className,
}: {
  startedAt: number;
  endsAt: number;
  now: number;
  /** Turn red and pulse near the end — only worth it when the player has
   * something left to do before time's up. */
  urgency?: boolean;
  className?: string;
}) {
  const gradientId = useId();
  const total = Math.max(endsAt - startedAt, 1);
  const left = Math.min(Math.max(endsAt - now, 0), total);
  const seconds = Math.ceil(left / 1000);
  const urgent = urgency && seconds <= URGENT_SECONDS && left > 0;

  return (
    <div
      role="timer"
      aria-label={`${seconds} seconds left`}
      className={cn(
        "relative flex size-14 shrink-0 items-center justify-center",
        urgent && "motion-safe:animate-timer-urgent",
        className,
      )}
    >
      <svg viewBox="0 0 48 48" className="absolute inset-0 -rotate-90">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--game-from)" />
            <stop offset="100%" stopColor="var(--game-to)" />
          </linearGradient>
        </defs>
        <circle
          cx="24"
          cy="24"
          r={RADIUS}
          fill="none"
          strokeWidth="4"
          className="stroke-muted"
        />
        <circle
          cx="24"
          cy="24"
          r={RADIUS}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          stroke={urgent ? "var(--destructive)" : `url(#${gradientId})`}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - left / total)}
          className="transition-[stroke-dashoffset,stroke] duration-200 ease-linear"
        />
      </svg>
      <span
        key={urgent ? seconds : undefined}
        className={cn(
          "text-base font-bold tabular-nums",
          urgent && "text-destructive motion-safe:animate-count-tick",
        )}
      >
        {seconds}
      </span>
    </div>
  );
}
