// A shared, coarse "now" for relative timestamps (see RelativeTime). One
// interval drives every subscriber, so a feed of a hundred posts costs one
// timer instead of a hundred, and the interval only runs while something is
// subscribed.
//
// The snapshot must stay current even when nothing has been ticking it
// (issue #758): after the last subscriber leaves, the timer stops, and the
// next timestamp may mount many minutes later (e.g. after a stretch on
// /chats, which shows none). So reading the clock refreshes a stale value
// instead of trusting the last tick. "Stale" has a small floor so repeated
// reads within one render still agree, as `useSyncExternalStore` requires.

export const CLOCK_TICK_MS = 30_000;
// While no timer runs, a read refreshes a value older than this.
const IDLE_MAX_AGE_MS = 1_000;

export type ClockDeps = {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

export type SharedClock = {
  /** Subscribe to ticks; returns the unsubscribe function. */
  subscribe: (callback: () => void) => () => void;
  /** The current shared "now" — refreshed on read if it has gone stale. */
  getNow: () => number;
  /** The last value without refreshing (stable for server rendering). */
  getServerNow: () => number;
};

export function createSharedClock(
  deps: ClockDeps = {
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  },
): SharedClock {
  const listeners = new Set<() => void>();
  let now = deps.now();
  let timer: unknown = null;

  const tick = () => {
    now = deps.now();
    for (const l of listeners) l();
  };

  const getNow = () => {
    const t = deps.now();
    // While ticking, the interval keeps `now` fresh — unless the browser
    // throttled it (a background tab), which the tick-length bound catches.
    const maxAge = timer === null ? IDLE_MAX_AGE_MS : CLOCK_TICK_MS;
    if (t - now >= maxAge) now = t;
    return now;
  };

  const subscribe = (callback: () => void) => {
    listeners.add(callback);
    if (timer === null) {
      // First subscriber after an idle stretch: make sure the value it
      // compares against is current, then start ticking.
      getNow();
      timer = deps.setInterval(tick, CLOCK_TICK_MS);
    }
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0 && timer !== null) {
        deps.clearInterval(timer);
        timer = null;
      }
    };
  };

  return { subscribe, getNow, getServerNow: () => now };
}

export const sharedClock = createSharedClock();
