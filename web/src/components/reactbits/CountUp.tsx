import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export type CountUpProps = {
  value: number;
  duration?: number;
  className?: string;
};

// Animated number roll adapted from reactbits' CountUp — eases from the
// previous value to the new one instead of snapping when it changes.
export function CountUp({ value, duration = 600, className }: CountUpProps) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  // Bumped on every change so the number also gets a one-line kick as it
  // rolls (`animate-count-tick`): at the small type these counters sit at, an
  // eased digit swap on its own is easy to miss entirely. Keying the span on
  // it is what replays the animation — a class that never left the element
  // wouldn't restart.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    setTick((prev) => prev + 1);
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        fromRef.current = value;
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return (
    <span
      key={tick}
      className={cn("motion-safe:animate-count-tick", className)}
    >
      {display}
    </span>
  );
}
