import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { InMemoryPubSubLive } from "./PubSub.ts";
import { RealtimeConnections, RealtimeConnectionsLive } from "./Realtime.ts";

// RealtimeConnectionsLive now delivers through PubSub (see Realtime.ts) — the
// in-memory implementation is the fully correct single-process one, not a
// stand-in, so these tests stay exactly as fast/synchronous as before.
const TestRealtimeLive = RealtimeConnectionsLive.pipe(
  Layer.provide(InMemoryPubSubLive),
);

// A writer that just records every chunk it was asked to send, standing in
// for a real `/ws` socket's outbound channel.
const recordingWriter = () => {
  const received: string[] = [];
  const write = (chunk: string) =>
    Effect.sync(() => {
      received.push(chunk);
    });
  return { write, received };
};

const run = <A, E>(effect: Effect.Effect<A, E, RealtimeConnections>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestRealtimeLive)));

test("notifyUsers delivers only to the listed users, not to everyone connected", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const alice = recordingWriter();
      const bob = recordingWriter();
      yield* connections.register(1, alice.write);
      yield* connections.register(2, bob.write);

      yield* connections.notifyUsers([1], { type: "chat_updated", chatId: 42 });

      expect(alice.received).toEqual([
        JSON.stringify({ type: "chat_updated", chatId: 42 }),
      ]);
      expect(bob.received).toEqual([]);
    }),
  );
});

test("notifyUsers delivers to every writer registered for a user (multiple tabs)", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const tabA = recordingWriter();
      const tabB = recordingWriter();
      yield* connections.register(1, tabA.write);
      yield* connections.register(1, tabB.write);

      yield* connections.notifyUsers([1], { type: "chat_updated", chatId: 7 });

      expect(tabA.received).toHaveLength(1);
      expect(tabB.received).toHaveLength(1);
    }),
  );
});

test("notifyUsers deduplicates repeated user ids so a writer isn't called twice", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const alice = recordingWriter();
      yield* connections.register(1, alice.write);

      yield* connections.notifyUsers([1, 1, 1], {
        type: "chat_updated",
        chatId: 1,
      });

      expect(alice.received).toHaveLength(1);
    }),
  );
});

test("unregister stops further delivery to that connection", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const alice = recordingWriter();
      const unregister = yield* connections.register(1, alice.write);

      unregister();
      yield* connections.notifyUsers([1], { type: "chat_updated", chatId: 1 });

      expect(alice.received).toEqual([]);
    }),
  );
});

test("unregistering one of a user's two connections leaves the other receiving events", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const tabA = recordingWriter();
      const tabB = recordingWriter();
      const unregisterA = yield* connections.register(1, tabA.write);
      yield* connections.register(1, tabB.write);

      unregisterA();
      yield* connections.notifyUsers([1], { type: "chat_updated", chatId: 1 });

      expect(tabA.received).toEqual([]);
      expect(tabB.received).toHaveLength(1);
    }),
  );
});

test("a failing writer doesn't stop other writers from being notified", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const broken = { write: () => Effect.fail("boom") };
      const alice = recordingWriter();
      yield* connections.register(1, broken.write);
      yield* connections.register(2, alice.write);

      yield* connections.notifyUsers([1, 2], {
        type: "chat_updated",
        chatId: 1,
      });

      expect(alice.received).toHaveLength(1);
    }),
  );
});

test("broadcastAll reaches every connected user regardless of chat participation", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const alice = recordingWriter();
      const bob = recordingWriter();
      yield* connections.register(1, alice.write);
      yield* connections.register(2, bob.write);

      yield* connections.broadcastAll({ type: "post_changed", postId: 99 });

      const expected = JSON.stringify({ type: "post_changed", postId: 99 });
      expect(alice.received).toEqual([expected]);
      expect(bob.received).toEqual([expected]);
    }),
  );
});

test("broadcastAll doesn't reach a user who has since unregistered", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const alice = recordingWriter();
      const unregister = yield* connections.register(1, alice.write);
      unregister();

      yield* connections.broadcastAll({ type: "post_changed", postId: 1 });

      expect(alice.received).toEqual([]);
    }),
  );
});

test("notifyUsers is a no-op for a user with no live connection", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      // No registrations at all — this should simply not throw.
      yield* connections.notifyUsers([1, 2, 3], {
        type: "chat_updated",
        chatId: 1,
      });
    }),
  );
});

test("different RealtimeConnectionsLive instances don't share state", async () => {
  // Regression guard for the sharing this feature depends on: main.ts
  // provides one RealtimeConnectionsLive instance to both the chat/post
  // handlers and the `/ws` route so they see the same registry. This proves
  // the layer itself creates an independent registry per instantiation
  // (Effect's memoization, not the layer's own code, is what keeps a single
  // process on one shared instance).
  const alice = recordingWriter();
  await Effect.runPromise(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      yield* connections.register(1, alice.write);
    }).pipe(Effect.provide(TestRealtimeLive)),
  );

  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      yield* connections.notifyUsers([1], { type: "chat_updated", chatId: 1 });
    }),
  );

  expect(alice.received).toEqual([]);
});
