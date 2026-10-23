import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Effect } from "effect";
import { IN_MEMORY_SWEEP_INTERVAL_MS } from "./RateLimiter.ts";
import {
  InMemoryWsTicketLive,
  makeInMemoryWsTicket,
  WsTicket,
} from "./WsTicket.ts";

const run = <A, E>(effect: Effect.Effect<A, E, WsTicket>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(InMemoryWsTicketLive)));

test("a ticket redeems to the userId it was issued for", async () => {
  const userId = await run(
    Effect.gen(function* () {
      const wsTicket = yield* WsTicket;
      const ticket = yield* wsTicket.issue(42);
      return yield* wsTicket.consume(ticket);
    }),
  );
  expect(userId).toBe(42);
});

test("a ticket can only be redeemed once", async () => {
  const [first, second] = await run(
    Effect.gen(function* () {
      const wsTicket = yield* WsTicket;
      const ticket = yield* wsTicket.issue(7);
      const a = yield* wsTicket.consume(ticket);
      const b = yield* wsTicket.consume(ticket);
      return [a, b] as const;
    }),
  );
  expect(first).toBe(7);
  expect(second).toBeNull();
});

test("an unknown ticket redeems to null", async () => {
  const userId = await run(
    Effect.gen(function* () {
      const wsTicket = yield* WsTicket;
      return yield* wsTicket.consume("never-issued");
    }),
  );
  expect(userId).toBeNull();
});

afterEach(() => {
  setSystemTime();
});

test("never-redeemed tickets are swept, so the store stays bounded", () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const { service: wsTicket, size } = makeInMemoryWsTicket();
  const perTick = 100;
  let peak = 0;
  for (let tick = 0; tick < 10; tick++) {
    // Minted, never used — the tab closed before the `/ws` upgrade.
    for (let i = 0; i < perTick; i++) Effect.runSync(wsTicket.issue(i));
    peak = Math.max(peak, size());
    setSystemTime(new Date(Date.now() + IN_MEMORY_SWEEP_INTERVAL_MS));
  }
  // The 30s TTL is shorter than a sweep interval, so each sweep clears
  // everything minted before it.
  expect(peak).toBeLessThanOrEqual(2 * perTick);
});

test("the sweep keeps a ticket that hasn't expired yet", () => {
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const { service: wsTicket } = makeInMemoryWsTicket();
  setSystemTime(new Date(Date.now() + IN_MEMORY_SWEEP_INTERVAL_MS));
  const ticket = Effect.runSync(wsTicket.issue(9)); // runs the sweep
  setSystemTime(new Date(Date.now() + 1_000));
  expect(Effect.runSync(wsTicket.consume(ticket))).toBe(9);
});
