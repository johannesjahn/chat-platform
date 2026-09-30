import {
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ArrowBigUp, Hourglass, Skull, Undo2 } from "lucide-react";
import { TypingDots } from "@/components/reactbits/TypingDots";
import { serverNow } from "@/lib/games/lobby";
import {
  comboMultiplier,
  directionAt,
  reactionRating,
  REFLEX_DECOYS,
  REFLEX_KIND_COPY,
  REFLEX_SYMBOLS,
  REFLEX_TARGET_RADIUS,
  type LocalRoundResult,
  type ReflexDirection,
  type ReflexPress,
  type ReflexRound,
  type ReflexView,
} from "@/lib/games/reflex";
import { cn } from "@/lib/utils";
import { REFLEX_KIND_ICONS } from "./kinds";
import { ReflexBurst, type ReflexBurstHandle } from "./ReflexBurst";

const ROTATION: Record<ReflexDirection, number> = {
  up: 0,
  right: 90,
  down: 180,
  left: 270,
};
// Where an arrow streaks in from: the side opposite the way it points.
const ARROW_FROM: Record<ReflexDirection, { x: number; y: number }> = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left: { x: 1, y: 0 },
  right: { x: -1, y: 0 },
};

const HIT_SPARKS = [
  "oklch(0.95 0.12 145)",
  "oklch(0.85 0.2 150)",
  "oklch(0.88 0.16 85)",
  "white",
];

type Tone =
  | "idle"
  | "intro"
  | "armed"
  | "go"
  | "aim"
  | "decoy-amber"
  | "decoy-blue"
  | "decoy-red"
  | "hit"
  | "early"
  | "miss";

function toneOf(
  round: ReflexRound | undefined,
  view: ReflexView,
  result: LocalRoundResult | undefined,
): Tone {
  if (!round || view.stage === "before" || view.stage === "done") {
    return "idle";
  }
  if (result && view.stage !== "intro") {
    return result.outcome === "hit"
      ? "hit"
      : result.outcome === "early"
        ? "early"
        : "miss";
  }
  switch (view.stage) {
    case "intro":
      return "intro";
    case "wait":
      if (round.kind === "decoy" && view.cue !== null) {
        return `decoy-${REFLEX_DECOYS[round.cues[view.cue]!.variant]?.tone ?? "amber"}`;
      }
      return "armed";
    case "signal":
      // A Snap round's light stays put: the symbol is the only signal.
      if (round.kind === "match") return "armed";
      return round.kind === "arrow" || round.kind === "target" ? "aim" : "go";
    default:
      return "miss";
  }
}

// The stage the whole game plays out on — every round's title card, the
// armed wait, the signal, and the verdict, drawn from the schedule and the
// player's own result. Presses on it (a tap, a click) go to the engine; so
// do keys, from the play area. For a spectator it's the same show, with
// nothing to press.
export function ReflexArena({
  ref,
  rounds,
  view,
  result,
  streak,
  whiffs,
  interactive,
  onPress,
  fastest,
  children,
}: {
  ref?: Ref<HTMLDivElement>;
  rounds: ReadonlyArray<ReflexRound>;
  view: ReflexView;
  /** The player's own result for the round on stage, once there is one. */
  result: LocalRoundResult | undefined;
  /** Clean hits in a row going into this round. */
  streak: number;
  whiffs: ReadonlyArray<{ id: number; x: number; y: number }>;
  interactive: boolean;
  onPress: (press: ReflexPress) => void;
  /** The round's quickest hit in the lobby so far — what a spectator sees. */
  fastest: { name: string; ms: number } | null;
  /** Overlays (the countdown). */
  children?: ReactNode;
}) {
  const round = view.stage === "before" ? undefined : rounds[view.index];
  const tone = toneOf(round, view, result);
  const burstRef = useRef<ReflexBurstHandle>(null);

  // A hit bursts into sparks where it landed (the center, for a key).
  useEffect(() => {
    if (result?.outcome !== "hit") return;
    burstRef.current?.burst(result.x ?? 0.5, result.y ?? 0.45, {
      colors: HIT_SPARKS,
      count: 36 + Math.min(streak, 5) * 12,
      power: 0.8 + Math.min(streak, 5) * 0.08,
    });
  }, [result, streak]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive || event.button > 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    onPress({
      source: "pointer",
      at: event.timeStamp,
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
      direction: round?.kind === "arrow" ? directionAt(x, y) : undefined,
    });
  };

  return (
    <div
      ref={ref}
      data-tone={tone}
      onPointerDown={handlePointerDown}
      className={cn(
        // As wide as the panel, but never so tall the round track and score
        // above it scroll off a laptop screen.
        "reflex-arena relative isolate mx-auto aspect-[16/10] w-full max-w-[calc(64svh*1.6)] touch-none select-none overflow-hidden rounded-2xl",
        interactive && "cursor-crosshair",
      )}
    >
      <div aria-hidden className="reflex-floor" />
      <div aria-hidden className="reflex-scanlines" />

      {/* Re-keyed per round and outcome, so a false start shakes every
          time. */}
      <div
        key={`${view.index}-${result?.outcome ?? "none"}`}
        className={cn(
          "absolute inset-0 z-10",
          result?.outcome === "early" && "motion-safe:animate-shake",
        )}
      >
        {round && (
          <RoundBadge round={round} index={view.index} total={rounds.length} />
        )}
        {round &&
          round.kind === "match" &&
          round.symbol !== null &&
          (view.stage === "wait" || view.stage === "signal") && (
            <span className="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-1 text-xs font-bold uppercase tracking-wider backdrop-blur-sm sm:text-sm">
              Only
              <span className="text-lg leading-none sm:text-2xl">
                {REFLEX_SYMBOLS[round.symbol]}
              </span>
            </span>
          )}
        {round && view.stage === "signal" && !result && (
          <LiveTimer signalAt={round.signalAt} />
        )}

        <div className="absolute inset-0 flex items-center justify-center p-4 text-center">
          <StageContent
            round={round}
            view={view}
            result={result}
            streak={streak}
            fastest={fastest}
            interactive={interactive}
          />
        </div>

        {round?.kind === "target" &&
          round.target &&
          view.stage === "signal" && (
            <Target
              key={view.index}
              x={round.target.x}
              y={round.target.y}
              windowMs={round.closeAt - round.signalAt}
              hit={result?.outcome === "hit"}
            />
          )}
        {round?.kind === "arrow" && interactive && view.stage !== "intro" && (
          <ArrowZones
            lit={view.stage === "signal" && !result ? round.direction : null}
          />
        )}
        {whiffs.map((whiff) => (
          <span
            key={whiff.id}
            aria-hidden
            className="pointer-events-none absolute size-12 rounded-full border-2 border-white/70 motion-safe:animate-reflex-whiff"
            style={{ left: `${whiff.x * 100}%`, top: `${whiff.y * 100}%` }}
          />
        ))}
      </div>

      <ReflexBurst ref={burstRef} />
      {children}
    </div>
  );
}

function RoundBadge({
  round,
  index,
  total,
}: {
  round: ReflexRound;
  index: number;
  total: number;
}) {
  const Icon = REFLEX_KIND_ICONS[round.kind];
  return (
    <span className="absolute left-3 top-3 z-20 flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-white/85 backdrop-blur-sm sm:text-xs">
      <Icon className="size-3.5" />
      {index + 1}/{total}
      <span className="hidden text-white/60 sm:inline">
        · {REFLEX_KIND_COPY[round.kind].title}
      </span>
    </span>
  );
}

// The milliseconds ticking up from the signal, written straight into the
// DOM each frame rather than re-rendering React 60 times a second.
function LiveTimer({ signalAt }: { signalAt: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      if (ref.current) {
        ref.current.textContent = String(
          Math.max(0, Math.round(serverNow() - signalAt)),
        );
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [signalAt]);
  return (
    <span className="absolute right-3 bottom-3 z-20 rounded-full bg-black/35 px-3 py-1 font-mono text-xs font-bold tabular-nums text-white/90 backdrop-blur-sm sm:text-sm">
      <span ref={ref}>0</span> ms
    </span>
  );
}

function StageContent({
  round,
  view,
  result,
  streak,
  fastest,
  interactive,
}: {
  round: ReflexRound | undefined;
  view: ReflexView;
  result: LocalRoundResult | undefined;
  streak: number;
  fastest: { name: string; ms: number } | null;
  interactive: boolean;
}) {
  if (view.stage === "done") {
    return (
      <div className="flex flex-col items-center gap-2 motion-safe:animate-reflex-card-in">
        <span className="text-3xl font-black uppercase italic tracking-tight sm:text-5xl">
          That&apos;s the game!
        </span>
        <span className="inline-flex items-center gap-2 text-sm text-white/70">
          Tallying scores
          <TypingDots />
        </span>
      </div>
    );
  }
  if (!round) return null;

  if (view.stage === "intro") {
    const Icon = REFLEX_KIND_ICONS[round.kind];
    const copy = REFLEX_KIND_COPY[round.kind];
    return (
      <div
        key={`intro-${view.index}`}
        className="flex flex-col items-center gap-1.5 motion-safe:animate-reflex-card-in sm:gap-2"
      >
        <span className="text-[11px] font-bold uppercase tracking-[0.45em] text-white/60 sm:text-xs">
          Round {view.index + 1}
        </span>
        <span className="flex items-center gap-2 text-3xl font-black uppercase italic tracking-tight drop-shadow-[0_4px_24px_rgba(0,0,0,0.5)] sm:gap-3 sm:text-6xl">
          <Icon className="size-7 sm:size-12" />
          {copy.title}
        </span>
        <span className="max-w-sm text-xs text-white/75 sm:text-base">
          {round.kind === "match" && round.symbol !== null ? (
            <>
              Hit only on{" "}
              <span className="text-xl sm:text-3xl">
                {REFLEX_SYMBOLS[round.symbol]}
              </span>
            </>
          ) : (
            copy.instruction
          )}
        </span>
        {round.kind === "arrow" && interactive && (
          <span className="text-[11px] text-white/55 sm:text-xs">
            Arrow keys / WASD — or tap that side of the arena
          </span>
        )}
      </div>
    );
  }

  if (result) return <Verdict result={result} round={round} streak={streak} />;

  if (view.stage === "wait") return <Armed round={round} cue={view.cue} />;

  if (view.stage === "signal") return <Signal round={round} />;

  // The window closed without a press from this viewer.
  return (
    <div
      key={`closed-${view.index}`}
      className="flex flex-col items-center gap-1 motion-safe:animate-reflex-slam"
    >
      {interactive ? (
        <>
          <Hourglass className="size-8 text-white/70 sm:size-12" />
          <span className="text-3xl font-black uppercase italic sm:text-5xl">
            Too slow
          </span>
        </>
      ) : fastest ? (
        <>
          <span className="text-xs font-bold uppercase tracking-[0.3em] text-white/60">
            Fastest
          </span>
          <span className="text-4xl font-black tabular-nums sm:text-6xl">
            {fastest.ms}
            <span className="text-lg sm:text-2xl"> ms</span>
          </span>
          <span className="text-sm text-white/75">{fastest.name}</span>
        </>
      ) : (
        <span className="text-2xl font-black uppercase italic text-white/80 sm:text-4xl">
          Round over
        </span>
      )}
    </div>
  );
}

// The armed wait: a beating core (or, for a Snap round, the symbol card
// dealing out wrong answers), plus whatever decoy is flashing right now.
function Armed({ round, cue }: { round: ReflexRound; cue: number | null }) {
  if (round.kind === "match") {
    const variant = cue === null ? null : round.cues[cue]!.variant;
    return (
      <SymbolCard
        key={cue ?? "blank"}
        symbol={variant === null ? null : REFLEX_SYMBOLS[variant]!}
      />
    );
  }
  const decoy =
    round.kind === "decoy" && cue !== null
      ? REFLEX_DECOYS[round.cues[cue]!.variant]
      : undefined;
  return (
    <div className="relative flex items-center justify-center">
      <Core
        label={round.kind === "target" ? "Aim" : "Wait"}
        radar={round.kind === "target"}
      />
      {decoy && (
        <span
          key={cue}
          className={cn(
            "absolute text-6xl font-black italic tracking-tighter motion-safe:animate-reflex-flash sm:text-9xl",
            decoy.tone === "red"
              ? "text-[oklch(0.68_0.24_25)] drop-shadow-[0_0_30px_oklch(0.6_0.24_25)]"
              : "text-white drop-shadow-[0_0_30px_rgba(255,255,255,0.6)]",
          )}
        >
          {decoy.label}
        </span>
      )}
    </div>
  );
}

function Core({ label, radar }: { label: string; radar: boolean }) {
  return (
    <div className="relative flex size-32 items-center justify-center sm:size-48">
      <span
        aria-hidden
        className="absolute inset-0 rounded-full border-2 border-dashed border-white/25 motion-safe:animate-reflex-spin"
      />
      <span
        aria-hidden
        className="absolute inset-3 rounded-full border border-white/15 motion-safe:animate-reflex-spin-reverse sm:inset-5"
      />
      {radar && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-[conic-gradient(from_0deg,transparent_0deg,oklch(0.85_0.18_150/0.45)_40deg,transparent_60deg)] motion-safe:animate-reflex-sweep"
        />
      )}
      <span
        aria-hidden
        className="absolute inset-8 rounded-full bg-[radial-gradient(circle,oklch(0.7_0.22_25/0.9),oklch(0.45_0.2_25/0.6)_60%,transparent_72%)] shadow-[0_0_50px_oklch(0.6_0.24_25/0.6)] motion-safe:animate-reflex-heartbeat sm:inset-11"
      />
      <span className="relative text-sm font-black uppercase tracking-[0.35em] text-white/90 sm:text-lg">
        {label}
      </span>
    </div>
  );
}

// A Snap round's card. The right symbol arrives exactly like the wrong ones
// — same card, same thump, no change of light — so it can only be told
// apart by looking at it.
function SymbolCard({ symbol }: { symbol: string | null }) {
  return (
    <span className="flex size-28 items-center justify-center rounded-3xl border-2 border-white/25 bg-black/30 text-6xl shadow-2xl backdrop-blur-sm motion-safe:animate-reflex-thump sm:size-44 sm:text-8xl">
      {symbol ?? (
        <span className="text-4xl font-black text-white/40 motion-safe:animate-reflex-bob sm:text-6xl">
          ?
        </span>
      )}
    </span>
  );
}

function Shockwave() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2 size-40 rounded-full border-white/90 motion-safe:animate-reflex-shock"
    />
  );
}

// The signal itself. Never faded in — it has to be fully there in the frame
// it's timed from; the motion is all flourish around it.
function Signal({ round }: { round: ReflexRound }) {
  if (round.kind === "match") {
    return (
      <SymbolCard key="signal" symbol={REFLEX_SYMBOLS[round.symbol ?? 0]!} />
    );
  }
  if (round.kind === "target") {
    return (
      <span className="self-end pb-6 text-xs font-bold uppercase tracking-[0.4em] text-white/70">
        Hit it!
      </span>
    );
  }
  if (round.kind === "arrow" && round.direction) {
    const from = ARROW_FROM[round.direction];
    return (
      <div className="relative flex items-center justify-center">
        <Shockwave />
        <span
          className="motion-safe:animate-reflex-arrow-in"
          style={
            {
              "--arrow-from-x": from.x,
              "--arrow-from-y": from.y,
            } as CSSProperties
          }
        >
          <ArrowBigUp
            aria-label={`Arrow pointing ${round.direction}`}
            className="size-32 fill-white text-white drop-shadow-[0_0_40px_rgba(255,255,255,0.8)] sm:size-56"
            style={{ transform: `rotate(${ROTATION[round.direction]}deg)` }}
          />
        </span>
      </div>
    );
  }
  return (
    <div className="relative flex items-center justify-center">
      <Shockwave />
      <span className="text-7xl font-black italic tracking-tighter drop-shadow-[0_0_40px_rgba(255,255,255,0.9)] sm:text-[10rem]">
        TAP!
      </span>
    </div>
  );
}

function Target({
  x,
  y,
  windowMs,
  hit,
}: {
  x: number;
  y: number;
  windowMs: number;
  hit: boolean;
}) {
  return (
    <span
      aria-label="Target"
      className="pointer-events-none absolute aspect-square -translate-x-1/2 -translate-y-1/2"
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        width: `${REFLEX_TARGET_RADIUS * 200}%`,
      }}
    >
      {!hit && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full border-2 border-white/80 motion-safe:animate-reflex-approach"
          style={{ "--approach-ms": `${windowMs}ms` } as CSSProperties}
        />
      )}
      <span
        className={cn(
          "absolute inset-0 rounded-full bg-[radial-gradient(circle,white_0_14%,oklch(0.7_0.24_25)_15%_32%,white_33%_48%,oklch(0.7_0.24_25)_49%_66%,white_67%)] shadow-[0_0_30px_oklch(0.95_0.1_145/0.9)]",
          hit && "scale-125 opacity-0 transition duration-300",
        )}
      />
    </span>
  );
}

// The four sides of the arena an Arrows round is answered on by touch —
// faint chevrons at each edge, the right one lighting up on the signal.
function ArrowZones({ lit }: { lit: ReflexDirection | null }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {(Object.keys(ROTATION) as ReflexDirection[]).map((direction) => (
        <ArrowBigUp
          key={direction}
          className={cn(
            "absolute size-7 transition-opacity duration-150 sm:size-10",
            direction === "up" && "left-1/2 top-2 -translate-x-1/2",
            direction === "down" && "bottom-2 left-1/2 -translate-x-1/2",
            direction === "left" && "left-2 top-1/2 -translate-y-1/2",
            direction === "right" && "right-2 top-1/2 -translate-y-1/2",
            lit === direction
              ? "fill-white text-white opacity-100"
              : "text-white opacity-25",
          )}
          style={{ rotate: `${ROTATION[direction]}deg` }}
        />
      ))}
    </div>
  );
}

// The player's own verdict on the round, the instant they press.
function Verdict({
  result,
  round,
  streak,
}: {
  result: LocalRoundResult;
  round: ReflexRound;
  streak: number;
}) {
  if (result.outcome === "hit" && result.reactionMs !== null) {
    const combo = comboMultiplier(streak);
    return (
      <div className="flex flex-col items-center">
        <span className="text-xs font-bold uppercase tracking-[0.35em] text-white/75 motion-safe:animate-reflex-card-in sm:text-sm">
          {reactionRating(result.reactionMs)}
        </span>
        <span className="flex items-baseline gap-1 motion-safe:animate-reflex-slam">
          <span className="text-7xl font-black tabular-nums tracking-tighter drop-shadow-[0_0_30px_rgba(255,255,255,0.5)] sm:text-9xl">
            {result.reactionMs}
          </span>
          <span className="text-xl font-bold text-white/70 sm:text-3xl">
            ms
          </span>
        </span>
        <span className="flex items-center gap-2 text-lg font-bold text-[oklch(0.9_0.16_150)] motion-safe:animate-reflex-points sm:text-2xl">
          +{result.points}
          {combo > 1 && (
            <span className="rounded-full bg-[oklch(0.84_0.16_85)] px-2 py-0.5 text-xs font-black text-black sm:text-sm">
              ×{combo.toFixed(1)} combo
            </span>
          )}
        </span>
      </div>
    );
  }
  if (result.outcome === "early") {
    return (
      <div className="flex flex-col items-center gap-1">
        <span className="relative motion-safe:animate-reflex-slam">
          <span className="text-5xl font-black uppercase italic tracking-tight sm:text-8xl">
            Too soon!
          </span>
          <span
            aria-hidden
            className="absolute inset-0 text-5xl font-black uppercase italic tracking-tight text-[oklch(0.75_0.2_200)] opacity-70 mix-blend-screen motion-safe:animate-reflex-glitch sm:text-8xl"
          >
            Too soon!
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-lg font-bold text-[oklch(0.8_0.16_25)] sm:text-2xl">
          <Skull className="size-5" />−{-result.points} · combo lost
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1 motion-safe:animate-reflex-slam">
      {result.outcome === "wrong" ? (
        <Undo2 className="size-8 sm:size-12" />
      ) : (
        <Hourglass className="size-8 sm:size-12" />
      )}
      <span className="text-4xl font-black uppercase italic sm:text-6xl">
        {result.outcome === "wrong"
          ? round.kind === "arrow"
            ? "Wrong way"
            : "Missed"
          : "Too slow"}
      </span>
    </div>
  );
}
