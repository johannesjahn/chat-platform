import { useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  MessageSquareQuote,
  PenLine,
  Sparkles,
  Vote,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DrawingStageKind } from "@/lib/games/drawing";

const STEPS: ReadonlyArray<{
  kind: DrawingStageKind;
  label: string;
  icon: LucideIcon;
}> = [
  { kind: "draw", label: "Draw", icon: PenLine },
  { kind: "bluff", label: "Bluff", icon: MessageSquareQuote },
  { kind: "vote", label: "Vote", icon: Vote },
  { kind: "reveal", label: "Reveal", icon: Sparkles },
];

// Where the round is: Draw → Bluff → Vote → Reveal as a track, the current
// step lit by a highlight that *slides* along it as the stages change (the
// same trick as SegmentedControl), steps already behind it checked off.
export function StageTrack({ kind }: { kind: DrawingStageKind }) {
  const refs = useRef(new Map<DrawingStageKind, HTMLLIElement>());
  const [indicator, setIndicator] = useState<{
    left: number;
    width: number;
  } | null>(null);
  const current = STEPS.findIndex((step) => step.kind === kind);

  useLayoutEffect(() => {
    const node = refs.current.get(kind);
    if (!node) return;
    const measure = () =>
      setIndicator({ left: node.offsetLeft, width: node.offsetWidth });
    measure();
    // Labels hide and show across breakpoints; keep the pill on its step.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [kind]);

  return (
    <ol
      aria-label="Stage"
      className="relative flex w-fit items-center rounded-full border border-border/70 bg-background/50 p-0.5"
    >
      {indicator && (
        <span
          aria-hidden
          className="game-gradient absolute inset-y-0.5 rounded-full shadow-md shadow-[var(--game-glow)] transition-all duration-500 ease-spring"
          style={{ left: indicator.left, width: indicator.width }}
        />
      )}
      {STEPS.map((step, index) => {
        const done = index < current;
        const active = index === current;
        const Icon = done ? Check : step.icon;
        return (
          <li
            key={step.kind}
            ref={(node) => {
              if (node) refs.current.set(step.kind, node);
              else refs.current.delete(step.kind);
            }}
            aria-current={active ? "step" : undefined}
            className={cn(
              "relative z-10 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-300 sm:px-3",
              active
                ? "text-white"
                : done
                  ? "text-foreground/80"
                  : "text-muted-foreground",
            )}
          >
            <Icon
              key={done ? "done" : "todo"}
              className={cn(
                "size-3.5",
                done && "text-emerald-400 motion-safe:animate-like-pop",
              )}
            />
            <span className={cn(!active && "hidden sm:inline")}>
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
