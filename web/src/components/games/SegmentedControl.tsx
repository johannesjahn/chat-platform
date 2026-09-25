import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// A pill-shaped option switch whose highlight *slides* to the picked option
// rather than jumping — used for the leaderboard's period, and for any other
// small "one of a few views" choice on a game page.
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<{
    left: number;
    width: number;
  } | null>(null);

  useLayoutEffect(() => {
    const button = refs.current.get(value);
    if (!button) return;
    setIndicator({ left: button.offsetLeft, width: button.offsetWidth });
  }, [value, options]);

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "relative inline-flex rounded-full border border-border/70 bg-background/50 p-0.5",
        className,
      )}
    >
      {indicator && (
        <span
          aria-hidden
          className="game-gradient absolute inset-y-0.5 rounded-full shadow-md shadow-[var(--game-glow)] transition-all duration-300 ease-spring"
          style={{ left: indicator.left, width: indicator.width }}
        />
      )}
      {options.map((option) => (
        <button
          key={option.value}
          ref={(node) => {
            if (node) refs.current.set(option.value, node);
            else refs.current.delete(option.value);
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "relative z-10 rounded-full px-3 py-1 text-xs font-medium transition-colors duration-200",
            option.value === value
              ? "text-white"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
