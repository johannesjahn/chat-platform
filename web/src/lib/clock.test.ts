/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { CLOCK_TICK_MS, createSharedClock } from "./clock";
import { formatRelativeTime } from "./time";

const MINUTE = 60_000;

// A hand-driven clock: `advance` moves time and fires due intervals, like a
// fake timer, so the tests never wait on real time.
function fakeClock(start = 1_000_000_000_000) {
  let t = start;
  const intervals = new Map<
    number,
    { fn: () => void; ms: number; next: number }
  >();
  let nextId = 1;
  const deps = {
    now: () => t,
    setInterval: (fn: () => void, ms: number) => {
      const id = nextId++;
      intervals.set(id, { fn, ms, next: t + ms });
      return id;
    },
    clearInterval: (id: unknown) => {
      intervals.delete(id as number);
    },
  };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...intervals.values()]
        .filter((i) => i.next <= end)
        .sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      t = due.next;
      due.next += due.ms;
      due.fn();
    }
    t = end;
  };
  return { deps, advance, now: () => t, activeTimers: () => intervals.size };
}

describe("shared clock", () => {
  test("a timestamp mounted after a long idle period shows its real age", () => {
    const fake = fakeClock();
    const clock = createSharedClock(fake.deps);

    // A feed timestamp mounts, then unmounts (navigating to /chats).
    const unsubscribe = clock.subscribe(() => {});
    unsubscribe();
    expect(fake.activeTimers()).toBe(0);

    // Ten minutes with no subscriber, and so no ticks.
    const postedAt = fake.now();
    fake.advance(10 * MINUTE);

    // Back on the feed: the first render reads the clock before subscribing.
    expect(formatRelativeTime(postedAt, clock.getNow())).toBe("10m");
    clock.subscribe(() => {});
    expect(formatRelativeTime(postedAt, clock.getNow())).toBe("10m");
  });

  test("a clock created long before its first read isn't stale", () => {
    const fake = fakeClock();
    const clock = createSharedClock(fake.deps);
    fake.advance(20 * MINUTE);
    expect(clock.getNow()).toBe(fake.now());
  });

  test("repeated reads within a render agree", () => {
    const fake = fakeClock();
    const clock = createSharedClock(fake.deps);
    const first = clock.getNow();
    fake.advance(5);
    expect(clock.getNow()).toBe(first);
  });

  test("ticks notify subscribers and advance the value", () => {
    const fake = fakeClock();
    const clock = createSharedClock(fake.deps);
    let calls = 0;
    clock.subscribe(() => calls++);
    const start = clock.getNow();

    fake.advance(CLOCK_TICK_MS - 1);
    expect(calls).toBe(0);
    expect(clock.getNow()).toBe(start);

    fake.advance(1);
    expect(calls).toBe(1);
    expect(clock.getNow()).toBe(start + CLOCK_TICK_MS);
  });

  test("one interval for every subscriber, cleared after the last leaves", () => {
    const fake = fakeClock();
    const clock = createSharedClock(fake.deps);
    const a = clock.subscribe(() => {});
    const b = clock.subscribe(() => {});
    expect(fake.activeTimers()).toBe(1);
    a();
    expect(fake.activeTimers()).toBe(1);
    b();
    expect(fake.activeTimers()).toBe(0);
  });

  test("a throttled interval can't leave the value more than a tick old", () => {
    const fake = fakeClock();
    const clock = createSharedClock(fake.deps);
    clock.subscribe(() => {});
    // A background tab whose interval didn't fire: time moves on without
    // ticks (the timer is still registered with the clock).
    fake.deps.clearInterval(1);
    fake.advance(5 * MINUTE);
    expect(clock.getNow()).toBe(fake.now());
  });

  test("the server snapshot never refreshes on read", () => {
    const fake = fakeClock();
    const clock = createSharedClock(fake.deps);
    const initial = clock.getServerNow();
    fake.advance(10 * MINUTE);
    expect(clock.getServerNow()).toBe(initial);
  });
});
