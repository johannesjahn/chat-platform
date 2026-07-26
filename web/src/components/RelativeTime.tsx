import { useSyncExternalStore } from "react";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

// A single shared 30s clock drives every RelativeTime on the page, so a feed
// of a hundred posts costs one interval instead of a hundred. Subscribers are
// only notified while at least one <RelativeTime> is mounted — the interval is
// created on the first subscriber and cleared when the last unmounts.
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  if (timer === null) {
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 30_000);
  }
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function useNow(): number {
  // Server snapshot is a stable value — SSR renders the initial `now` and the
  // client reconciles on first tick, avoiding a hydration mismatch loop.
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
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
