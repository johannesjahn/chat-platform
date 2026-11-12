/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { createOwnWriteTracker } from "./ownWrites";

// A tracker on a hand-driven clock and timer list.
function setup() {
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const tracker = createOwnWriteTracker({
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { at: clock + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    rememberMs: 1_000,
    maxHoldMs: 500,
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers) {
      if (timer.live && timer.at <= clock) {
        timer.live = false;
        timer.fn();
      }
    }
  };
  const applied: number[] = [];
  const event = (scope: string, id: number) =>
    tracker.intercept(scope, id, () => applied.push(id));
  return { tracker, advance, applied, event };
}

describe("own write tracker", () => {
  test("applies events straight away while nothing is in flight", () => {
    const { applied, event } = setup();
    event("post", 1);
    expect(applied).toEqual([1]);
  });

  test("drops the echo that arrives before the response, applies the rest once it settles", () => {
    const { tracker, applied, event } = setup();
    const settle = tracker.begin("post");
    event("post", 7); // someone else's
    event("post", 8); // ours, ahead of the response
    expect(applied).toEqual([]);
    settle(8);
    expect(applied).toEqual([7]);
  });

  test("drops the echo that arrives after the response, once", () => {
    const { tracker, applied, event } = setup();
    tracker.begin("post")(8);
    event("post", 8);
    expect(applied).toEqual([]);
    event("post", 8);
    expect(applied).toEqual([8]);
  });

  test("forgets a created id after the remember window", () => {
    const { tracker, advance, applied, event } = setup();
    tracker.begin("post")(8);
    advance(1_001);
    event("post", 8);
    expect(applied).toEqual([8]);
  });

  test("a failed create applies everything it held", () => {
    const { tracker, applied, event } = setup();
    const settle = tracker.begin("post");
    event("post", 8);
    settle(null);
    expect(applied).toEqual([8]);
  });

  test("scopes are independent", () => {
    const { tracker, applied, event } = setup();
    const settle = tracker.begin("comments:1");
    event("comments:2", 5);
    event("post", 5);
    expect(applied).toEqual([5, 5]);
    settle(5);
    event("comments:2", 5);
    expect(applied).toEqual([5, 5, 5]);
  });

  test("holds until every create in the scope has settled", () => {
    const { tracker, applied, event } = setup();
    const first = tracker.begin("post");
    const second = tracker.begin("post");
    event("post", 3);
    event("post", 4);
    first(3);
    expect(applied).toEqual([]);
    second(9);
    expect(applied).toEqual([4]);
  });

  test("a create that never settles stops holding after maxHoldMs", () => {
    const { tracker, advance, applied, event } = setup();
    const settle = tracker.begin("post");
    event("post", 8);
    advance(500);
    expect(applied).toEqual([8]);
    // The late settle is a no-op.
    settle(8);
    event("post", 9);
    expect(applied).toEqual([8, 9]);
  });
});
