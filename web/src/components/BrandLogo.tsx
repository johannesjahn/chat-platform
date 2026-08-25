import { type CSSProperties } from "react";

import { cn } from "@/lib/utils";

// Three typing dots inside the bubble. The index drives both staggers (the
// mount pop-in and the hover bounce) through `--logo-dot-index`, so each
// animation keeps its own spacing without an inline `animation-delay` that
// would leak from one into the other — see the utilities in styles.css.
const DOTS = [10.5, 16, 21.5];

// A speech bubble, drawn as a single stroke so `logo-draw` can trace it in one
// continuous line. `pathLength={1}` normalises the geometry, which lets the
// dash utility work in plain 0..1 units instead of a magic pixel length.
const BUBBLE =
  "M6 4h20a4 4 0 0 1 4 4v11a4 4 0 0 1-4 4H14.5l-6 5v-5H6a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z";

export type BrandLogoProps = {
  className?: string;
};

/**
 * The animated brand mark. On mount the bubble traces its own outline and the
 * three dots pop in behind it, one at a time, as if a message were being typed
 * — the app's whole premise in about a second. Afterwards it settles into a
 * slow ambient glow, and reacts to hover (tilt + a quick dot bounce) when it
 * sits inside a `group`, e.g. the nav's brand link.
 *
 * Every moving part is a `prefers-reduced-motion`-aware utility, so with motion
 * reduced this renders as the plain static mark.
 */
export function BrandLogo({ className }: BrandLogoProps) {
  return (
    <span
      className={cn(
        "relative inline-flex size-5 shrink-0 items-center justify-center",
        className,
      )}
    >
      {/* Purely decorative halo — it breathes on its own and brightens on
          hover, which is what keeps the mark from looking flat once the
          entrance animation has finished. */}
      <span
        aria-hidden
        className="animate-logo-glow pointer-events-none absolute -inset-1 -z-10 rounded-full bg-primary/40 blur-md transition-opacity duration-300 ease-out group-hover:opacity-80"
      />
      <svg
        aria-hidden
        viewBox="0 0 32 32"
        fill="none"
        className="size-full text-primary transition-transform duration-300 ease-out group-hover:-rotate-6 group-hover:scale-110"
      >
        <path
          className="animate-logo-draw"
          pathLength={1}
          d={BUBBLE}
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {DOTS.map((cx, index) => (
          <circle
            key={cx}
            className="animate-logo-dot group-hover:animate-logo-dot-bounce"
            style={{ "--logo-dot-index": index } as CSSProperties}
            cx={cx}
            cy={13.5}
            r={2}
            fill="currentColor"
          />
        ))}
      </svg>
    </span>
  );
}
