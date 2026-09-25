import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { MousePointerClick } from "lucide-react";
import { cn } from "@/lib/utils";

// Keys that would move the (hidden) input's cursor away from the end of what
// was typed — the race only ever appends or backspaces.
const NAVIGATION_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

// How long after the last keystroke the caret goes back to blinking.
const IDLE_MS = 600;

// The passage being raced, rendered per character: what's been typed right
// is bright, a mistake glows red (and jolts), what's left is dim. A caret
// glides from character to character rather than jumping, holds solid while
// the racer types and blinks when they pause. Input goes through a
// transparent text field laid over the passage, so a tap anywhere focuses
// it — which is also what brings up a phone's keyboard.
export function TypingPassage({
  passage,
  typed,
  correct,
  errors,
  active,
  onInput,
  inputRef,
}: {
  passage: string;
  typed: string;
  correct: number;
  errors: number;
  /** Typing is unlocked (the race is live and this player is racing). */
  active: boolean;
  onInput: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const charRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState<{
    left: number;
    top: number;
    height: number;
  } | null>(null);
  const [focused, setFocused] = useState(false);
  const [typing, setTyping] = useState(false);

  // Words kept whole (a word never breaks across lines mid-way), each
  // character keeping its index into the passage.
  const words = useMemo(() => {
    const result: Array<Array<{ char: string; index: number }>> = [];
    let current: Array<{ char: string; index: number }> = [];
    [...passage].forEach((char, index) => {
      current.push({ char, index });
      if (char === " ") {
        result.push(current);
        current = [];
      }
    });
    if (current.length > 0) result.push(current);
    return result;
  }, [passage]);

  // Park the caret on the next character to type (or just past the last).
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const position = Math.min(typed.length, passage.length);
    const atEnd = position >= passage.length;
    const target = charRefs.current[atEnd ? passage.length - 1 : position];
    if (!target) return;
    setCaret({
      left: target.offsetLeft + (atEnd ? target.offsetWidth : 0),
      top: target.offsetTop,
      height: target.offsetHeight,
    });
  }, [typed.length, passage]);

  // Solid while typing, blinking once idle.
  useEffect(() => {
    if (typed.length === 0) return;
    const start = setTimeout(() => setTyping(true), 0);
    const stop = setTimeout(() => setTyping(false), IDLE_MS);
    return () => {
      clearTimeout(start);
      clearTimeout(stop);
    };
  }, [typed]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      NAVIGATION_KEYS.has(event.key) ||
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")
    ) {
      event.preventDefault();
    }
  };

  return (
    <div
      className={cn(
        "relative rounded-2xl border bg-background/50 px-5 py-6 transition-all duration-300 sm:px-7",
        active && focused
          ? "border-[color-mix(in_oklch,var(--game-from),transparent_40%)] shadow-[0_0_40px_-12px_var(--game-glow)]"
          : "border-border/60",
      )}
    >
      <div
        ref={containerRef}
        aria-hidden
        data-passage
        className="relative select-none font-mono text-lg leading-[2.1] tracking-tight sm:text-xl"
      >
        {words.map((word, wordIndex) => (
          <span key={wordIndex} className="inline-block whitespace-pre">
            {word.map(({ char, index }) => {
              const state =
                index < correct
                  ? "correct"
                  : index < typed.length
                    ? "error"
                    : "pending";
              return (
                <span
                  key={
                    // Re-keyed on the error count so a fresh mistake on the
                    // same character replays its jolt.
                    state === "error" ? `${index}-e${errors}` : index
                  }
                  ref={(node) => {
                    charRefs.current[index] = node;
                  }}
                  className={cn(
                    "inline-block rounded-[3px] transition-colors duration-150",
                    state === "correct" && "text-foreground",
                    state === "pending" && "text-muted-foreground/55",
                    state === "error" &&
                      "bg-destructive/25 text-destructive motion-safe:animate-type-error",
                    state === "error" &&
                      char === " " &&
                      "underline decoration-destructive decoration-2",
                  )}
                >
                  {char}
                </span>
              );
            })}
          </span>
        ))}
        {caret && active && (
          <span
            aria-hidden
            className={cn(
              "game-gradient pointer-events-none absolute left-0 top-0 w-[2px] rounded-full shadow-[0_0_10px_var(--game-from)] transition-transform duration-100 ease-out",
              !typing && "motion-safe:animate-caret-blink",
            )}
            style={{
              height: caret.height * 0.8,
              transform: `translate(${caret.left - 1}px, ${caret.top + caret.height * 0.1}px)`,
            }}
          />
        )}
      </div>

      <input
        ref={inputRef}
        value={typed}
        disabled={!active}
        onChange={(event) => onInput(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label="Type the passage"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        inputMode="text"
        className="absolute inset-0 h-full w-full cursor-text resize-none opacity-0"
      />

      {active && !focused && (
        <button
          type="button"
          onClick={() => inputRef.current?.focus()}
          className="absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-2xl bg-background/60 text-sm font-medium backdrop-blur-[2px] motion-safe:animate-in motion-safe:fade-in-0"
        >
          <MousePointerClick className="size-4 text-[var(--game-from)] motion-safe:animate-float" />
          Click here to keep typing
        </button>
      )}
    </div>
  );
}
