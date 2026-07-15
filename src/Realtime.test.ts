import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { InMemoryPresenceStoreLive } from "./Presence.ts";
import { InMemoryPubSubLive } from "./PubSub.ts";
import { RealtimeConnections, RealtimeConnectionsLive } from "./Realtime.ts";

// RealtimeConnectionsLive now delivers through PubSub (see Realtime.ts) — the
// in-memory implementation is the fully correct single-process one, not a
// stand-in, so these tests stay exactly as fast/synchronous as before. Same
// reasoning for InMemoryPresenceStoreLive (see Presence.ts).
const TestRealtimeLive = RealtimeConnectionsLive.pipe(
  Layer.provide(InMemoryPubSubLive),
  Layer.provide(InMemoryPresenceStoreLive),
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
      alice.received.length = 0;
      bob.received.length = 0;

      yield* connections.notifyUsers([1], {
        type: "chat_updated",
        chatId: 42,
        version: 1,
      });

      expect(alice.received).toEqual([
        JSON.stringify({ type: "chat_updated", chatId: 42, version: 1 }),
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
      tabA.received.length = 0;
      tabB.received.length = 0;

      yield* connections.notifyUsers([1], {
        type: "chat_updated",
        chatId: 7,
        version: 1,
      });

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
      alice.received.length = 0;

      yield* connections.notifyUsers([1, 1, 1], {
        type: "chat_updated",
        chatId: 1,
        version: 1,
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
      alice.received.length = 0;

      unregister();
      yield* connections.notifyUsers([1], {
        type: "chat_updated",
        chatId: 1,
        version: 1,
      });

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
      tabA.received.length = 0;
      tabB.received.length = 0;

      unregisterA();
      yield* connections.notifyUsers([1], {
        type: "chat_updated",
        chatId: 1,
        version: 1,
      });

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
      alice.received.length = 0;

      yield* connections.notifyUsers([1, 2], {
        type: "chat_updated",
        chatId: 1,
        version: 1,
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
      alice.received.length = 0;
      bob.received.length = 0;

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
      alice.received.length = 0;
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
        version: 1,
      });
    }),
  );
});

test("register broadcasts a presence online event the first time a user connects", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const alice = recordingWriter();
      const bob = recordingWriter();
      yield* connections.register(1, alice.write);
      yield* connections.register(2, bob.write);

      expect(alice.received).toEqual([
        JSON.stringify({ type: "presence", userId: 1, online: true }),
        JSON.stringify({ type: "presence", userId: 2, online: true }),
      ]);
      // Bob wasn't connected yet when Alice's own online transition
      // broadcast, so he only sees his own.
      expect(bob.received).toEqual([
        JSON.stringify({ type: "presence", userId: 2, online: true }),
      ]);
    }),
  );
});

test("a user's second simultaneous connection doesn't re-broadcast presence", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const tabA = recordingWriter();
      const tabB = recordingWriter();
      yield* connections.register(1, tabA.write);
      yield* connections.register(1, tabB.write);

      const presenceEvents = tabA.received.filter((m) =>
        m.includes('"type":"presence"'),
      );
      expect(presenceEvents).toHaveLength(1);
    }),
  );
});

test("unregistering a user's last connection broadcasts a presence offline event", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const alice = recordingWriter();
      const bob = recordingWriter();
      const unregisterAlice = yield* connections.register(1, alice.write);
      yield* connections.register(2, bob.write);

      unregisterAlice();
      // The broadcast fires from a sync callback via `Effect.runFork` (see
      // Realtime.ts), so give the fiber a tick to actually run.
      yield* Effect.sleep("10 millis");

      expect(bob.received.at(-1)).toEqual(
        JSON.stringify({ type: "presence", userId: 1, online: false }),
      );
    }),
  );
});

test("unregistering one of two connections for the same user doesn't broadcast offline", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const bob = recordingWriter();
      const tabA = recordingWriter();
      const tabB = recordingWriter();
      const unregisterA = yield* connections.register(1, tabA.write);
      yield* connections.register(1, tabB.write);
      yield* connections.register(2, bob.write);
      bob.received.length = 0;

      unregisterA();
      yield* Effect.sleep("10 millis");

      expect(bob.received).toEqual([]);
    }),
  );
});

test("onlineUserIds reflects users with at least one live connection", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const alice = recordingWriter();
      const bob = recordingWriter();
      const unregisterAlice = yield* connections.register(1, alice.write);
      yield* connections.register(2, bob.write);

      expect(new Set(yield* connections.onlineUserIds)).toEqual(
        new Set([1, 2]),
      );

      unregisterAlice();
      expect(yield* connections.onlineUserIds).toEqual([2]);
    }),
  );
});

test("notifyPostRoom reaches only sockets subscribed to that post", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const viewer = recordingWriter();
      const other = recordingWriter();
      yield* connections.register(1, viewer.write);
      yield* connections.register(2, other.write);
      // Only the viewer opens post 42's comment section.
      yield* connections.subscribePost(42, viewer.write);
      viewer.received.length = 0;
      other.received.length = 0;

      yield* connections.notifyPostRoom(42, {
        type: "comment_changed",
        postId: 42,
        commentId: 7,
      });

      expect(viewer.received).toEqual([
        JSON.stringify({
          type: "comment_changed",
          postId: 42,
          commentId: 7,
        }),
      ]);
      expect(other.received).toEqual([]);
    }),
  );
});

test("unsubscribePost stops further room delivery to that socket", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const viewer = recordingWriter();
      yield* connections.register(1, viewer.write);
      yield* connections.subscribePost(42, viewer.write);
      yield* connections.unsubscribePost(42, viewer.write);
      viewer.received.length = 0;

      yield* connections.notifyPostRoom(42, {
        type: "comment_changed",
        postId: 42,
        commentId: 1,
      });

      expect(viewer.received).toEqual([]);
    }),
  );
});

test("unregister removes a socket from every post room it had joined", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const viewer = recordingWriter();
      const unregister = yield* connections.register(1, viewer.write);
      yield* connections.subscribePost(42, viewer.write);
      viewer.received.length = 0;

      // A dropped connection never sends `unsubscribe_post_comments`, so the
      // registry must sweep it out of rooms on unregister.
      unregister();
      yield* connections.notifyPostRoom(42, {
        type: "comment_changed",
        postId: 42,
        commentId: 1,
      });

      expect(viewer.received).toEqual([]);
    }),
  );
});

test("a like on a post still broadcasts feed-wide, not just to the room", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const alice = recordingWriter();
      const bob = recordingWriter();
      yield* connections.register(1, alice.write);
      yield* connections.register(2, bob.write);
      alice.received.length = 0;
      bob.received.length = 0;

      yield* connections.broadcastAll({
        type: "like_changed",
        targetType: "post",
        targetId: 5,
        likeCount: 3,
      });

      const expected = JSON.stringify({
        type: "like_changed",
        targetType: "post",
        targetId: 5,
        likeCount: 3,
      });
      expect(alice.received).toEqual([expected]);
      expect(bob.received).toEqual([expected]);
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
  alice.received.length = 0;

  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      yield* connections.notifyUsers([1], {
        type: "chat_updated",
        chatId: 1,
        version: 1,
      });
    }),
  );

  expect(alice.received).toEqual([]);
});
