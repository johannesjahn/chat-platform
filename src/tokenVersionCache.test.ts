import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Cache, Effect, Layer } from "effect";
import { TokenVersionCache, TokenVersionCacheLive } from "./Auth.ts";
import { Db } from "./Db.ts";
import { PubSub } from "./PubSub.ts";
import { users } from "./db/schema.ts";
import { makeTestDbAccessor, resetTestDb } from "./testDb.ts";

const { getTestDb } = makeTestDbAccessor();

// A PubSub that never delivers anything and hands its reconnect listeners
// to the test, standing in for a Redis subscriber that dropped and came
// back — missing whatever was published in between.
const reconnectListeners: Array<Effect.Effect<void>> = [];
const SilentPubSubLive = Layer.succeed(PubSub, {
  publish: () => Effect.void,
  subscribe: () => Effect.void,
  unsubscribe: () => Effect.void,
  ping: Effect.void,
  onReconnect: (listener) =>
    Effect.sync(() => {
      reconnectListeners.push(listener);
    }),
});

const run = <A, E>(effect: Effect.Effect<A, E, Db | TokenVersionCache>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.promise(async () => {
        const db = await getTestDb();
        await resetTestDb(db);
        return db;
      });
      reconnectListeners.length = 0;
      const DbLive = Layer.succeed(Db, db);
      return yield* effect.pipe(
        Effect.provide(
          TokenVersionCacheLive.pipe(
            Layer.provideMerge(DbLive),
            Layer.provide(SilentPubSubLive),
          ),
        ),
      );
    }),
  );

test("a reconnect drops cached token versions, so an invalidation missed while disconnected can't linger (issue #833)", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const cache = yield* TokenVersionCache;
      const [user] = yield* Effect.promise(() =>
        db
          .insert(users)
          .values({ username: "revoked", passwordHash: "x" })
          .returning(),
      );
      expect(yield* Cache.get(cache, user!.id)).toBe(0);

      // "Log out everywhere" while this pod's subscriber was down: the
      // version moves on, but the invalidation never arrives.
      yield* Effect.promise(() =>
        db.update(users).set({ tokenVersion: 1 }).where(eq(users.id, user!.id)),
      );
      expect(yield* Cache.get(cache, user!.id)).toBe(0);

      expect(reconnectListeners).toHaveLength(1);
      yield* reconnectListeners[0]!;
      expect(yield* Cache.get(cache, user!.id)).toBe(1);
    }),
  ));
