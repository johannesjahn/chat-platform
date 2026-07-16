import { expect, test } from "bun:test";
import { Effect, Layer, Metric, MetricLabel } from "effect";
import { updateActiveUserGauges } from "./ActiveUsersMetrics.ts";
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
    Metric.value(
      Metric.taggedWithLabels(activeUsers, [
        MetricLabel.make("window", window),
      ]),
    ),
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
            contentType: "text",
            content: "hi",
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
          contentType: "text",
          content: "old",
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
