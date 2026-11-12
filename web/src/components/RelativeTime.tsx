import { useSyncExternalStore } from "react";
import { sharedClock } from "@/lib/clock";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

// Every RelativeTime reads one shared clock (see lib/clock.ts): one interval
// for the whole page, and a value that's re-read on mount after an idle
// stretch, so a timestamp never shows an age frozen at the last tick.
function useNow(): number {
  return useSyncExternalStore(
    sharedClock.subscribe,
    sharedClock.getNow,
    sharedClock.getServerNow,
  );
}

type RelativeTimeProps = {
  /** Milliseconds since the epoch. */
  value: number;
  className?: string;
};

// Renders a self-updating relative age ("3m", "2h") inside a semantic <time>
// element. The exact timestamp is always available via the native tooltip
// (`title`) and to assistive tech / crawlers via `dateTime`.
export function RelativeTime({ value, className }: RelativeTimeProps) {
  const current = useNow();
  return (
    <time
      dateTime={new Date(value).toISOString()}
      title={formatAbsoluteTime(value)}
      className={cn("tabular-nums", className)}
    >
      {formatRelativeTime(value, current)}
    </time>
  );
}
