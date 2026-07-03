import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type GradientTextProps = {
  children: ReactNode;
  className?: string;
  colors?: string[];
  speed?: number;
};

// Animated gradient heading text adapted from reactbits' GradientText — the
// gradient slowly drifts across the glyphs on a loop via background-position.
export function GradientText({
  children,
  className,
  colors = ["#a78bfa", "#818cf8", "#38bdf8", "#818cf8", "#a78bfa"],
  speed = 6,
}: GradientTextProps) {
  return (
    <span
      className={cn(
        "inline-block bg-clip-text text-transparent animate-gradient-shift",
        className,
      )}
      style={
        {
          backgroundImage: `linear-gradient(90deg, ${colors.join(", ")})`,
          backgroundSize: "300% 100%",
          animationDuration: `${speed}s`,
        } as CSSProperties
      }
    >
      {children}
    </span>
  );
}
