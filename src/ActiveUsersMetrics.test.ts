import { expect, test } from "bun:test";
import { Duration, Effect, Layer, Metric } from "effect";
import { eq } from "drizzle-orm";
import {
  ACTIVITY_RESOLUTION,
  updateActiveUserGauges,
} from "./ActiveUsersMetrics.ts";
import { Db } from "./Db.ts";
import { activeUsers } from "./Metrics.ts";
import { makeTestDbAccessor, resetTestDb } from "./testDb.ts";
import { chats, comments, likes, messages, posts, users } from "./db/schema.ts";

const { getTestDb } = makeTestDbAccessor();

const run = <A, E>(effect: Effect.Effect<A, E, Db>): Promise<A> => {
  const TestDbLive = Layer.effect(
    Db,
    Effect.promise(async () => {
      const db = await getTestDb();
      await resetTestDb(db);
      return db;
    }),
  );
  return Effect.runPromise(effect.pipe(Effect.provide(TestDbLive)));
};

const gaugeValue = (window: string) =>
  Effect.map(
    Metric.value(Metric.withAttributes(activeUsers, { window: window })),
    (state) => state.value,
  );

test("updateActiveUserGauges sets active_users{window} to the distinct count of users who created content in each trailing window, deduped across content types", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const [u1, u2, u3, u4] = yield* Effect.promise(() =>
        db
          .insert(users)
          .values([
            { username: "active-1d", passwordHash: "x" },
            { username: "active-7d", passwordHash: "x" },
            { username: "active-30d", passwordHash: "x" },
            { username: "active-none", passwordHash: "x" },
          ])
          .returning({ id: users.id }),
      );

      const now = Date.now();
      const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000);

      // u1 posted 2 hours ago — within every window.
      const [post] = yield* Effect.promise(() =>
        db
          .insert(posts)
          .values({
            authorId: u1!.id,
            body: "hi",
            createdAt: hoursAgo(2),
            updatedAt: hoursAgo(2),
          })
          .returning({ id: posts.id }),
      );

      // u2 commented 3 days ago — within 7d/30d, not 1d.
      yield* Effect.promise(() =>
        db.insert(comments).values({
          postId: post!.id,
          authorId: u2!.id,
          content: "nice",
          createdAt: hoursAgo(24 * 3),
          updatedAt: hoursAgo(24 * 3),
        }),
      );

      // u3 liked 10 days ago — within 30d only.
      yield* Effect.promise(() =>
        db.insert(likes).values({
          userId: u3!.id,
          postId: post!.id,
          createdAt: hoursAgo(24 * 10),
        }),
      );

      // u4 sent a message 40 days ago — outside every window.
      const [chat] = yield* Effect.promise(() =>
        db.insert(chats).values({ type: "direct" }).returning({ id: chats.id }),
      );
      yield* Effect.promise(() =>
        db.insert(messages).values({
          chatId: chat!.id,
          senderId: u4!.id,
          body: "old",
          createdAt: hoursAgo(24 * 40),
          updatedAt: hoursAgo(24 * 40),
        }),
      );

      yield* updateActiveUserGauges;

      expect(yield* gaugeValue("1d")).toBe(1);
      expect(yield* gaugeValue("7d")).toBe(2);
      expect(yield* gaugeValue("30d")).toBe(3);
    }),
  ));

// Issue #831: users.last_active_at, which the counts read, is kept by insert
// triggers — moved forward only once it's
// ACTIVITY_RESOLUTION behind, and never back.
test("content inserts move last_active_at forward, at most once per ACTIVITY_RESOLUTION and never backwards", () =>
  run(
    Effect.gen(function* () {
      const db = yield* Db;
      const [user] = yield* Effect.promise(() =>
        db
          .insert(users)
          .values({ username: "talker", passwordHash: "x" })
          .returning({ id: users.id }),
      );
      const [chat] = yield* Effect.promise(() =>
        db.insert(chats).values({ type: "direct" }).returning({ id: chats.id }),
      );
      const lastActive = () =>
        Effect.promise(() =>
          db
            .select({ at: users.lastActiveAt })
            .from(users)
            .where(eq(users.id, user!.id)),
        ).pipe(Effect.map((rows) => rows[0]?.at?.getTime() ?? null));
      const send = (at: number) =>
        Effect.promise(() =>
          db.insert(messages).values({
            chatId: chat!.id,
            senderId: user!.id,
            body: "hi",
            createdAt: new Date(at),
            updatedAt: new Date(at),
          }),
        );
      const resolution = Duration.toMillis(ACTIVITY_RESOLUTION);
      const start = Date.now() - 5 * resolution;

      expect(yield* lastActive()).toBeNull();
      yield* send(start);
      expect(yield* lastActive()).toBe(start);
      // Within the resolution: nothing is written.
      yield* send(start + resolution - 1000);
      expect(yield* lastActive()).toBe(start);
      // Past it: moved.
      yield* send(start + 2 * resolution);
      expect(yield* lastActive()).toBe(start + 2 * resolution);
      // An older row never moves it back.
      yield* send(start - 10 * resolution);
      expect(yield* lastActive()).toBe(start + 2 * resolution);

      // Every content type counts, each through its own author column.
      const [post] = yield* Effect.promise(() =>
        db
          .insert(posts)
          .values({
            authorId: user!.id,
            body: "hi",
            createdAt: new Date(start + 4 * resolution),
            updatedAt: new Date(start + 4 * resolution),
          })
          .returning({ id: posts.id }),
      );
      expect(yield* lastActive()).toBe(start + 4 * resolution);
      const [other] = yield* Effect.promise(() =>
        db
          .insert(users)
          .values({ username: "liker", passwordHash: "x" })
          .returning({ id: users.id }),
      );
      const otherActive = () =>
        Effect.promise(() =>
          db
            .select({ at: users.lastActiveAt })
            .from(users)
            .where(eq(users.id, other!.id)),
        ).pipe(Effect.map((rows) => rows[0]?.at?.getTime() ?? null));
      yield* Effect.promise(() =>
        db.insert(likes).values({
          userId: other!.id,
          postId: post!.id,
          createdAt: new Date(start),
        }),
      );
      expect(yield* otherActive()).toBe(start);
      yield* Effect.promise(() =>
        db.insert(comments).values({
          postId: post!.id,
          authorId: other!.id,
          content: "nice",
          createdAt: new Date(start + 3 * resolution),
          updatedAt: new Date(start + 3 * resolution),
        }),
      );
      expect(yield* otherActive()).toBe(start + 3 * resolution);
    }),
  ));
