import { RedisClient } from "bun";
import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { PresenceStore, RedisPresenceStoreLive } from "./Presence.ts";

// Same "needs a real Redis" gating as RealtimePubSub.integration.test.ts —
// these exercise RedisPresenceStoreLive's actual Redis behavior (hash field
// TTLs), which InMemoryPresenceStoreLive has no equivalent of, so they can't
// run against it.
const redisConfigured = Boolean(process.env.REDIS_URL);

const KEY = "chat-platform:presence:counts";

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

      const [ttl] = await inspector.httl(KEY, "FIELDS", 1, String(userId));
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

      const exists = await inspector.hexists(KEY, String(userId));
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
        KEY,
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
        KEY,
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
