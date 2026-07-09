import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { RedisPubSubLive } from "./PubSub.ts";
import { RealtimeConnections, RealtimeConnectionsLive } from "./Realtime.ts";

// Everything else touching Realtime.ts runs against InMemoryPubSubLive,
// which is correct but only ever exercises single-process delivery. This is
// the one test that proves the actual point of PubSub.ts: an event
// published by one RealtimeConnectionsLive instance reaches a connection
// registered on a *different* instance, via a real Redis both share — the
// scenario that matters once the app is horizontally scaled. It needs a
// real Redis reachable at REDIS_URL, so it's skipped unless one is
// configured (docker-compose's `redis` service, or CI — see
// .github/workflows/ci.yml).
const redisConfigured = Boolean(process.env.REDIS_URL);

(redisConfigured ? test : test.skip)(
  "an event published from one instance reaches a connection registered on another, via Redis",
  async () => {
    // Each simulates one horizontally-scaled app instance: its own
    // RealtimeConnectionsLive (own local connection registry) backed by its
    // own dedicated pair of Redis connections, sharing the same server.
    const instanceA = ManagedRuntime.make(
      RealtimeConnectionsLive.pipe(Layer.provide(RedisPubSubLive)),
    );
    const instanceB = ManagedRuntime.make(
      RealtimeConnectionsLive.pipe(Layer.provide(RedisPubSubLive)),
    );

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
      const presenceDeadline = Date.now() + 5000;
      while (received.length === 0 && Date.now() < presenceDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
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

      // Cross-instance delivery goes over the network — poll rather than
      // assert immediately.
      const deadline = Date.now() + 5000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect(received).toEqual([
        JSON.stringify({ type: "chat_updated", chatId: 1 }),
      ]);
    } finally {
      await instanceA.dispose();
      await instanceB.dispose();
    }
  },
);
