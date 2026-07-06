import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Effect, Layer } from "effect";
import { Db } from "./Db.ts";
import { cleanupExpiredRefreshTokens } from "./RefreshTokenCleanup.ts";
import { refreshTokens, users } from "./db/schema.ts";
import * as schema from "./db/schema.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Db>): Promise<A> => {
  const TestDbLive = Layer.effect(
    Db,
    Effect.promise(async () => {
      const db = drizzle({ schema });
      await migrate(db, { migrationsFolder: "./drizzle" });
      return db;
    }),
  );
  return Effect.runPromise(effect.pipe(Effect.provide(TestDbLive)));
};

test("cleanupExpiredRefreshTokens deletes only rows past their expiresAt", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const [user] = yield* Effect.promise(() =>
        db
          .insert(users)
          .values({ username: "cleanup-user", passwordHash: "x" })
          .returning({ id: users.id }),
      );

      const now = Date.now();
      yield* Effect.promise(() =>
        db.insert(refreshTokens).values([
          {
            jti: "expired",
            userId: user!.id,
            expiresAt: new Date(now - 1000),
          },
          { jti: "live", userId: user!.id, expiresAt: new Date(now + 100_000) },
        ]),
      );

      yield* cleanupExpiredRefreshTokens;

      const remaining = yield* Effect.promise(() =>
        db.select({ jti: refreshTokens.jti }).from(refreshTokens),
      );
      expect(remaining.map((r) => r.jti)).toEqual(["live"]);
    }),
  ));
