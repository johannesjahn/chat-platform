import { expect, test } from "bun:test";
import { Effect } from "effect";
import { InMemoryWsTicketLive, WsTicket } from "./WsTicket.ts";

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
