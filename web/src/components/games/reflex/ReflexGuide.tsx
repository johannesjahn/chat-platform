import type { CSSProperties, ReactNode } from "react";
import { ArrowBigLeft, Flame, Skull, Timer } from "lucide-react";
import {
  REFLEX_KIND_COPY,
  REFLEX_SYMBOLS,
  type ReflexKind,
} from "@/lib/games/reflex";
import { cn } from "@/lib/utils";
import { REFLEX_KIND_ICONS } from "./kinds";

// A tiny looping picture of each round kind, on a slice of arena.
const DEMOS: Record<ReflexKind, ReactNode> = {
  go: (
    <>
      <span className="absolute inset-0 bg-[oklch(0.55_0.2_25)] motion-safe:animate-reflex-demo-go" />
      <span className="relative text-xs font-black italic tracking-widest">
        WAIT… TAP!
      </span>
    </>
  ),
  decoy: (
    <>
      <span className="absolute inset-0 bg-[oklch(0.55_0.2_25)] motion-safe:animate-reflex-demo-decoy" />
      <span className="relative text-xs font-black italic tracking-widest">
        NOT YET…
      </span>
    </>
  ),
  match: (
    <span className="flex items-center gap-1 text-base">
      <span className="opacity-40">{REFLEX_SYMBOLS[2]}</span>
      <span className="opacity-40">{REFLEX_SYMBOLS[1]}</span>
      <span className="rounded-md bg-white/20 px-1 text-xl ring-1 ring-white/70">
        {REFLEX_SYMBOLS[0]}
      </span>
    </span>
  ),
  arrow: (
    <ArrowBigLeft className="size-7 fill-white text-white motion-safe:animate-reflex-bob" />
  ),
  target: (
    <span className="relative size-7">
      <span className="absolute inset-0 rounded-full border border-white/80 motion-safe:animate-ping" />
      <span className="absolute inset-0 rounded-full bg-[radial-gradient(circle,white_0_18%,oklch(0.7_0.24_25)_19%_40%,white_41%_60%,oklch(0.7_0.24_25)_61%)]" />
    </span>
  ),
};

const KINDS = Object.keys(REFLEX_KIND_COPY) as ReflexKind[];

// The waiting room's cheat sheet: the five kinds of round a game mixes, and
// how points work — so nobody's first false start is a surprise.
export function ReflexGuide() {
  return (
    <div className="flex flex-col gap-3">
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {KINDS.map((kind, index) => {
          const Icon = REFLEX_KIND_ICONS[kind];
          return (
            <li
              key={kind}
              style={{ "--stagger-index": index } as CSSProperties}
              className={cn(
                "flex flex-col gap-2 rounded-xl border border-border/50 bg-background/40 p-2.5",
                "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:fill-mode-both stagger-in",
                index === KINDS.length - 1 && "col-span-2 sm:col-span-1",
              )}
            >
              <span className="relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-lg bg-[oklch(0.16_0.03_220)] text-white">
                {DEMOS[kind]}
              </span>
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                <Icon className="size-3.5 text-[var(--game-from)]" />
                {REFLEX_KIND_COPY[kind].title}
              </span>
              <span className="text-xs leading-snug text-muted-foreground">
                {REFLEX_KIND_COPY[kind].instruction}
              </span>
            </li>
          );
        })}
      </ol>
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li className="inline-flex items-center gap-1">
          <Timer className="size-3.5" />
          Faster = more points, up to 1000 a round
        </li>
        <li className="inline-flex items-center gap-1">
          <Flame className="size-3.5" />
          Clean streaks multiply, up to ×1.5
        </li>
        <li className="inline-flex items-center gap-1">
          <Skull className="size-3.5" />
          Jump early (or under 100ms) and lose 200
        </li>
      </ul>
    </div>
  );
}
