import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { RedisPresenceStoreLive } from "./Presence.ts";
import { RedisPubSubLive } from "./PubSub.ts";
import { RealtimeConnections, RealtimeConnectionsLive } from "./Realtime.ts";

// Everything else touching Realtime.ts runs against InMemoryPubSubLive /
// InMemoryPresenceStoreLive, which are correct but only ever exercise
// single-process behavior. This file is what proves the actual point of
// PubSub.ts and Presence.ts: state published/incremented by one
// RealtimeConnectionsLive instance is visible to another, via a real Redis
// both share — the scenario that matters once the app is horizontally
// scaled. It needs a real Redis reachable at REDIS_URL, so it's skipped
// unless one is configured (docker-compose's `redis` service, or CI — see
// .github/workflows/ci.yml).
const redisConfigured = Boolean(process.env.REDIS_URL);

// Each simulates one horizontally-scaled app instance: its own
// RealtimeConnectionsLive (own local connection registry) backed by its own
// dedicated pair of Redis connections, sharing the same server.
const makeInstance = () =>
  ManagedRuntime.make(
    RealtimeConnectionsLive.pipe(
      Layer.provide(RedisPubSubLive),
      Layer.provide(RedisPresenceStoreLive),
    ),
  );

// Cross-instance delivery goes over the network — poll rather than assert
// immediately.
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

(redisConfigured ? test : test.skip)(
  "an event published from one instance reaches a connection registered on another, via Redis",
  async () => {
    const instanceA = makeInstance();
    const instanceB = makeInstance();

    try {
      const received: string[] = [];
      const write = (chunk: string) =>
        Effect.sync(() => {
          received.push(chunk);
        });

      // The connection lives only on instance B.
      await instanceB.runPromise(
        Effect.gen(function* () {
          const connections = yield* RealtimeConnections;
          yield* connections.register(1, write);
        }),
      );

      // `register` itself broadcasts a `presence` event over the same real
      // Redis channel (see Realtime.ts) — that broadcast is also delivered
      // here, and it's async (unlike the in-memory PubSub), so wait for it
      // to land and clear it rather than asserting on it below; this test's
      // subject is `chat_updated` delivery specifically.
      await waitFor(() => received.length > 0);
      expect(received).toEqual([
        JSON.stringify({ type: "presence", userId: 1, online: true }),
      ]);
      received.length = 0;

      // The mutation is handled by instance A.
      await instanceA.runPromise(
        Effect.gen(function* () {
          const connections = yield* RealtimeConnections;
          yield* connections.notifyUsers([1], {
            type: "chat_updated",
            chatId: 1,
          });
        }),
      );

      await waitFor(() => received.length > 0);
      expect(received).toEqual([
        JSON.stringify({ type: "chat_updated", chatId: 1 }),
      ]);
    } finally {
      await instanceA.dispose();
      await instanceB.dispose();
    }
  },
);

(redisConfigured ? test : test.skip)(
  "a user connected across two instances broadcasts exactly one online and one offline transition, via PresenceStore's shared Redis count",
  async () => {
    const instanceA = makeInstance();
    const instanceB = makeInstance();
    // Fresh ids per run, distinct from the ones the test above uses, so a
    // previous run against a persistent (non-CI) Redis can't leave stale
    // counts that would throw this test's own transition detection off.
    const userId = Date.now();
    const observerId = userId + 1;

    try {
      // A third, unrelated connection that stays up for the whole test.
      // Presence is broadcast to everyone (see Realtime.ts), and a
      // connection never receives its own online/offline transition (see
      // the "unregistering a user's last connection..." case in
      // Realtime.test.ts) — so this observer, not `userId`'s own sockets,
      // is what actually proves how many transitions were broadcast.
      const observed: string[] = [];
      const observerWrite = (chunk: string) =>
        Effect.sync(() => {
          observed.push(chunk);
        });
      await instanceA.runPromise(
        Effect.gen(function* () {
          const connections = yield* RealtimeConnections;
          yield* connections.register(observerId, observerWrite);
        }),
      );
      // Wait out and discard the observer's own online echo before it
      // could be confused for `userId`'s.
      await waitFor(() => observed.length > 0);
      expect(observed).toEqual([
        JSON.stringify({ type: "presence", userId: observerId, online: true }),
      ]);
      observed.length = 0;

      const noop = () => Effect.void;
      const unregisterA = await instanceA.runPromise(
        Effect.gen(function* () {
          const connections = yield* RealtimeConnections;
          return yield* connections.register(userId, noop);
        }),
      );
      await waitFor(() => observed.length > 0);
      expect(observed).toEqual([
        JSON.stringify({ type: "presence", userId, online: true }),
      ]);

      // A second connection for the *same* user, landing on a *different*
      // instance — without PresenceStore, instance B's own local count
      // would look like a fresh 0→1 transition and re-announce them online.
      const unregisterB = await instanceB.runPromise(
        Effect.gen(function* () {
          const connections = yield* RealtimeConnections;
          return yield* connections.register(userId, noop);
        }),
      );
      // Give a moment for a wrongly-duplicated broadcast to arrive if it
      // were going to.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(observed).toHaveLength(1);

      // Disconnecting the instance A connection must not broadcast offline
      // — the instance B connection is still live elsewhere.
      unregisterA();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(observed).toHaveLength(1);

      // Only once neither instance holds a connection does offline fire.
      unregisterB();
      await waitFor(() => observed.length > 1);
      expect(observed).toEqual([
        JSON.stringify({ type: "presence", userId, online: true }),
        JSON.stringify({ type: "presence", userId, online: false }),
      ]);
    } finally {
      await instanceA.dispose();
      await instanceB.dispose();
    }
  },
);
