import { RedisClient } from "bun";
import { expect, test } from "bun:test";
import { Duration, Effect, Layer, ManagedRuntime } from "effect";
import {
  type PresenceChange,
  PresenceHeartbeat,
  PresenceStore,
  PRESENCE_BUCKETS,
  presenceCountsKey,
  RedisPresenceStoreLive,
} from "./Presence.ts";

// Same "needs a real Redis" gating as RealtimePubSub.integration.test.ts —
// these exercise RedisPresenceStoreLive's actual Redis behavior (hash field
// TTLs), which InMemoryPresenceStoreLive has no equivalent of, so they can't
// run against it.
const redisConfigured = Boolean(process.env.REDIS_URL);

// Fresh ids per test, distinct from every other Presence-related test file,
// so a previous run against a persistent (non-CI) Redis can't leave a stale
// field/TTL that would throw a test's assertions off.
let nextUserId = Date.now();
const freshUserId = () => nextUserId++;

(redisConfigured ? test : test.skip)(
  "connect sets a TTL on the user's Redis hash field, so a hard process kill can't leak it forever",
  async () => {
    const runtime = ManagedRuntime.make(RedisPresenceStoreLive);
    const inspector = new RedisClient(process.env.REDIS_URL);
    const userId = freshUserId();

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PresenceStore;
          yield* store.connect(userId);
        }),
      );

      const [ttl] = await inspector.httl(
        presenceCountsKey(userId),
        "FIELDS",
        1,
        String(userId),
      );
      // A field with no connect would report -2 (missing); one with no TTL
      // (the old HINCRBY-only behavior) would report -1. A positive TTL no
      // greater than the configured window proves `connect` actually armed
      // the safety net rather than leaving the field to live forever.
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    } finally {
      await runtime.dispose();
      inspector.close();
    }
  },
);

(redisConfigured ? test : test.skip)(
  "a graceful disconnect removes the field (and its TTL) immediately, same as before",
  async () => {
    const runtime = ManagedRuntime.make(RedisPresenceStoreLive);
    const inspector = new RedisClient(process.env.REDIS_URL);
    const userId = freshUserId();

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PresenceStore;
          yield* store.connect(userId);
          yield* store.disconnect(userId);
        }),
      );

      const exists = await inspector.hexists(
        presenceCountsKey(userId),
        String(userId),
      );
      expect(exists).toBe(false);
    } finally {
      await runtime.dispose();
      inspector.close();
    }
  },
);

(redisConfigured ? test : test.skip)(
  "the background heartbeat refreshes the TTL for as long as the connection is held, so a long-lived connection doesn't age out",
  async () => {
    const runtime = ManagedRuntime.make(RedisPresenceStoreLive);
    const inspector = new RedisClient(process.env.REDIS_URL);
    const userId = freshUserId();

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PresenceStore;
          yield* store.connect(userId);
        }),
      );

      const [ttlAfterConnect] = await inspector.httl(
        presenceCountsKey(userId),
        "FIELDS",
        1,
        String(userId),
      );
      expect(ttlAfterConnect).toBeGreaterThan(0);

      // Let the TTL run down well past what it'd be without a heartbeat
      // refresh (the heartbeat fires every 20s — see HEARTBEAT_INTERVAL in
      // Presence.ts), then confirm it's back up near the full window rather
      // than having kept counting down from the connect-time value.
      await new Promise((resolve) => setTimeout(resolve, 22_000));

      const [ttlAfterHeartbeat] = await inspector.httl(
        presenceCountsKey(userId),
        "FIELDS",
        1,
        String(userId),
      );
      expect(ttlAfterHeartbeat).toBeGreaterThan(30);
    } finally {
      await runtime.dispose();
      inspector.close();
    }
  },
  30_000,
);

(redisConfigured ? test : test.skip)(
  "onlineAmong answers for just the ids it's asked about, across buckets, in the order asked",
  async () => {
    const runtime = ManagedRuntime.make(RedisPresenceStoreLive);
    const online = freshUserId();
    const offline = freshUserId();
    const gone = freshUserId();

    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* PresenceStore;
          yield* store.connect(online);
          yield* store.connect(gone);
          yield* store.disconnect(gone);
          yield* store.connect(offline + PRESENCE_BUCKETS);
          const found = yield* store.onlineAmong([
            offline,
            offline + PRESENCE_BUCKETS,
            online,
            gone,
            online,
          ]);
          yield* store.disconnect(online);
          yield* store.disconnect(offline + PRESENCE_BUCKETS);
          return found;
        }),
      );
      expect(result).toEqual([offline + PRESENCE_BUCKETS, online, online]);
    } finally {
      await runtime.dispose();
    }
  },
);

// Issue #837: instances that heartbeat fast and are reaped soon after they
// stop, so a test can play out a crash in well under a second. Disposing a
// runtime stands in for a hard kill: its heartbeat stops, but nothing calls
// `disconnect` for the connections it held.
const FastHeartbeatLive = Layer.succeed(PresenceHeartbeat, {
  interval: Duration.millis(50),
  deadAfter: Duration.millis(300),
});
const instance = () =>
  ManagedRuntime.make(
    RedisPresenceStoreLive.pipe(Layer.provide(FastHeartbeatLive)),
  );

const recordChanges = async (runtime: ReturnType<typeof instance>) => {
  const changes: PresenceChange[] = [];
  await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* PresenceStore;
      yield* store.onPresenceChange((batch) =>
        Effect.sync(() => {
          changes.push(...batch);
        }),
      );
    }),
  );
  return changes;
};

const waitUntil = async (predicate: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

(redisConfigured ? test : test.skip)(
  "a user whose only connection was on an instance that died goes offline, and another instance says so (issue #837)",
  async () => {
    const dead = instance();
    const survivor = instance();
    const inspector = new RedisClient(process.env.REDIS_URL);
    const userId = freshUserId();
    try {
      const changes = await recordChanges(survivor);
      await dead.runPromise(
        Effect.flatMap(PresenceStore, (store) => store.connect(userId)),
      );
      expect(
        await inspector.hget(presenceCountsKey(userId), String(userId)),
      ).toBe("1");

      await dead.dispose();
      await waitUntil(() =>
        changes.some((c) => c.userId === userId && !c.online),
      );
      expect(
        await inspector.hget(presenceCountsKey(userId), String(userId)),
      ).toBeNull();
    } finally {
      await survivor.dispose();
      inspector.close();
    }
  },
);

(redisConfigured ? test : test.skip)(
  "counts are spread over more than one key, and a dead instance's users go offline in every bucket (issue #832)",
  async () => {
    const dead = instance();
    const survivor = instance();
    const inspector = new RedisClient(process.env.REDIS_URL);
    const users = [freshUserId(), freshUserId(), freshUserId()];
    try {
      expect(new Set(users.map(presenceCountsKey)).size).toBe(users.length);
      const changes = await recordChanges(survivor);
      await dead.runPromise(
        Effect.forEach(users, (userId) =>
          Effect.flatMap(PresenceStore, (store) => store.connect(userId)),
        ),
      );
      for (const userId of users) {
        expect(
          await inspector.hget(presenceCountsKey(userId), String(userId)),
        ).toBe("1");
      }

      await dead.dispose();
      await waitUntil(() =>
        users.every((userId) =>
          changes.some((c) => c.userId === userId && !c.online),
        ),
      );
      for (const userId of users) {
        expect(
          await inspector.hexists(presenceCountsKey(userId), String(userId)),
        ).toBe(false);
      }
    } finally {
      await survivor.dispose();
      inspector.close();
    }
  },
);

(redisConfigured ? test : test.skip)(
  "a user still connected to a live instance stays online when another of their instances dies",
  async () => {
    const dead = instance();
    const survivor = instance();
    const inspector = new RedisClient(process.env.REDIS_URL);
    const userId = freshUserId();
    try {
      const changes = await recordChanges(survivor);
      await dead.runPromise(
        Effect.flatMap(PresenceStore, (store) => store.connect(userId)),
      );
      await survivor.runPromise(
        Effect.flatMap(PresenceStore, (store) => store.connect(userId)),
      );
      expect(
        await inspector.hget(presenceCountsKey(userId), String(userId)),
      ).toBe("2");

      await dead.dispose();
      await waitUntil(
        async () =>
          (await inspector.hget(presenceCountsKey(userId), String(userId))) ===
          "1",
      );
      expect(changes.some((c) => c.userId === userId)).toBe(false);

      // And leaving the live instance now really is going offline.
      const wentOffline = await survivor.runPromise(
        Effect.flatMap(PresenceStore, (store) => store.disconnect(userId)),
      );
      expect(wentOffline).toBe(true);
    } finally {
      await survivor.dispose();
      inspector.close();
    }
  },
);

(redisConfigured ? test : test.skip)(
  "an instance wrongly taken for dead puts its connections back and reports them online again",
  async () => {
    const paused = instance();
    const inspector = new RedisClient(process.env.REDIS_URL);
    const userId = freshUserId();
    try {
      const pausedChanges = await recordChanges(paused);
      await paused.runPromise(
        Effect.flatMap(PresenceStore, (store) => store.connect(userId)),
      );

      // Do to it what REAP_SCRIPT does to an instance it takes for dead —
      // as if a long pause had let another instance reap it.
      const instances = (await inspector.send("ZRANGE", [
        "chat-platform:presence:v2:instances",
        "0",
        "-1",
      ])) as string[];
      let reaped = 0;
      for (const id of instances) {
        const sharesKey = `chat-platform:presence:v2:instance:${id}`;
        const share = await inspector.hget(sharesKey, String(userId));
        if (share === null) continue;
        await inspector.send("ZREM", [
          "chat-platform:presence:v2:instances",
          id,
        ]);
        await inspector.hincrby(
          presenceCountsKey(userId),
          String(userId),
          -Number(share),
        );
        await inspector.hdel(presenceCountsKey(userId), String(userId));
        await inspector.del(sharesKey);
        reaped++;
      }
      expect(reaped).toBe(1);
      expect(
        await inspector.hget(presenceCountsKey(userId), String(userId)),
      ).toBeNull();

      // Its next beat finds itself unregistered and restores its share.
      await waitUntil(
        async () =>
          (await inspector.hget(presenceCountsKey(userId), String(userId))) ===
          "1",
      );
      await waitUntil(() =>
        pausedChanges.some((c) => c.userId === userId && c.online),
      );

      // Leaving now is an ordinary transition to offline again.
      const wentOffline = await paused.runPromise(
        Effect.flatMap(PresenceStore, (store) => store.disconnect(userId)),
      );
      expect(wentOffline).toBe(true);
    } finally {
      await paused.dispose();
      inspector.close();
    }
  },
);
