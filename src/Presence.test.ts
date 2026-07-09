import { expect, test } from "bun:test";
import { Effect } from "effect";
import { InMemoryPresenceStoreLive, PresenceStore } from "./Presence.ts";

const run = <A, E>(effect: Effect.Effect<A, E, PresenceStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(InMemoryPresenceStoreLive)));

test("connect reports the transition to online only for a user's first connection", () =>
  run(
    Effect.gen(function* () {
      const store = yield* PresenceStore;
      expect(yield* store.connect(1)).toBe(true);
      expect(yield* store.connect(1)).toBe(false);
      expect(yield* store.connect(1)).toBe(false);
    }),
  ));

test("disconnect reports the transition to offline only once every connection is gone", () =>
  run(
    Effect.gen(function* () {
      const store = yield* PresenceStore;
      yield* store.connect(1);
      yield* store.connect(1);
      yield* store.connect(1);

      expect(yield* store.disconnect(1)).toBe(false);
      expect(yield* store.disconnect(1)).toBe(false);
      expect(yield* store.disconnect(1)).toBe(true);
    }),
  ));

test("disconnect for a user with no live connections is a no-op, not a spurious offline transition", () =>
  run(
    Effect.gen(function* () {
      const store = yield* PresenceStore;
      expect(yield* store.disconnect(1)).toBe(false);
      expect(yield* store.onlineUserIds).toEqual([]);
    }),
  ));

test("onlineUserIds reflects exactly the users with at least one connection", () =>
  run(
    Effect.gen(function* () {
      const store = yield* PresenceStore;
      yield* store.connect(1);
      yield* store.connect(2);
      yield* store.connect(2);

      expect(new Set(yield* store.onlineUserIds)).toEqual(new Set([1, 2]));

      yield* store.disconnect(1);
      expect(yield* store.onlineUserIds).toEqual([2]);

      yield* store.disconnect(2);
      expect(yield* store.onlineUserIds).toEqual([2]);
      yield* store.disconnect(2);
      expect(yield* store.onlineUserIds).toEqual([]);
    }),
  ));
