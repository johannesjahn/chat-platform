import { expect, test } from "bun:test";
import { Duration, Effect, Layer } from "effect";
import { InMemoryPresenceStoreLive } from "./Presence.ts";
import { staticPresenceAudience } from "./PresenceAudience.ts";
import { InMemoryPubSubLive, PubSub } from "./PubSub.ts";
import {
  InMemoryUserLocatorLive,
  makeInMemoryUserLocator,
  UserLocator,
} from "./UserLocator.ts";
import {
  SERVER_DRAINING_CLOSE_CODE,
  FEED_ROOM,
  FeedHeadInterval,
  MAX_FEED_HEAD_POST_IDS,
  PostReactionsInterval,
  MAX_POST_ROOMS_PER_CONNECTION,
  MAX_ROOMS_PER_CONNECTION,
  gameHubRoom,
  gameLobbyRoom,
  isValidRoomName,
  RealtimeConnections,
  RealtimeConnectionsLive,
  RoomChannelLinger,
} from "./Realtime.ts";
import { makeIncomingHandler } from "./RealtimeSocket.ts";

// RealtimeConnectionsLive now delivers through PubSub (see Realtime.ts) — the
// in-memory implementation is the fully correct single-process one, not a
// stand-in, so these tests stay exactly as fast/synchronous as before. Same
// reasoning for InMemoryPresenceStoreLive (see Presence.ts). Users 1 and 2
// share a chat, and so see each other's presence/status; users 3 and 4 share
// a chat with no one (see PresenceAudience.ts).
const FEED_HEAD_TEST_INTERVAL_MS = 20;
const TestRealtimeLive = RealtimeConnectionsLive.pipe(
  Layer.provide(InMemoryUserLocatorLive),
  Layer.provide(InMemoryPubSubLive),
  Layer.provide(InMemoryPresenceStoreLive),
  Layer.provide(staticPresenceAudience([[1, 2]])),
  Layer.provide(
    Layer.succeed(
      FeedHeadInterval,
      Duration.millis(FEED_HEAD_TEST_INTERVAL_MS),
    ),
  ),
  Layer.provide(
    Layer.succeed(
      PostReactionsInterval,
      Duration.millis(FEED_HEAD_TEST_INTERVAL_MS),
    ),
  ),
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

      yield* connections.broadcastAll({
        type: "post_changed",
        postId: 99,
        change: "created",
      });

      const expected = JSON.stringify({
        type: "post_changed",
        postId: 99,
        change: "created",
      });
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

      yield* connections.broadcastAll({
        type: "post_changed",
        postId: 1,
        change: "created",
      });

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

test("register pushes a presence online event to contacts the first time a user connects", async () => {
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
      // Bob wasn't connected yet when Alice's own online transition went
      // out, so he only sees his own.
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

test("unregistering a user's last connection pushes a presence offline event to contacts", async () => {
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

test("onlineContactIds reflects only the user's contacts with a live connection", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const unregisterAlice = yield* connections.register(1, () => Effect.void);
      yield* connections.register(2, () => Effect.void);
      // Online, but shares no chat with anyone.
      yield* connections.register(3, () => Effect.void);

      expect(yield* connections.onlineContactIds(2)).toEqual([1]);
      expect(yield* connections.onlineContactIds(1)).toEqual([2]);
      expect(yield* connections.onlineContactIds(3)).toEqual([]);

      unregisterAlice();
      expect(yield* connections.onlineContactIds(2)).toEqual([]);
    }),
  );
});

// Issue #684: after a chat's membership changes, the users who just became
// contacts are told about each other right away, not on their next connect.
test("introduceContacts tells online newcomers and members about each other", async () => {
  // A group of 1 (owner), 2, 3 and 4, which 5 and 6 just joined. 4 is
  // offline; 3 and 5 have blocked each other, so the audience leaves that
  // pair out (as PresenceAudienceLive would).
  const members = [1, 2, 3, 4, 5, 6];
  const pairs = members
    .flatMap((a) => members.map((b) => [a, b] as const))
    .filter(([a, b]) => a < b && !(a === 3 && b === 5));
  await Effect.runPromise(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const writers = new Map(
        [1, 2, 3, 5, 6].map((userId) => [userId, recordingWriter()]),
      );
      for (const [userId, writer] of writers) {
        yield* connections.register(userId, writer.write);
      }
      for (const writer of writers.values()) writer.received.length = 0;

      yield* connections.introduceContacts([5, 6], members);

      const onlineIds = (userId: number) =>
        writers
          .get(userId)!
          .received.map((chunk) => JSON.parse(chunk))
          .map((event) => {
            expect(event.type).toBe("presence");
            expect(event.online).toBe(true);
            return event.userId as number;
          })
          .sort((a, b) => a - b);

      expect(onlineIds(1)).toEqual([5, 6]);
      expect(onlineIds(2)).toEqual([5, 6]);
      expect(onlineIds(3)).toEqual([6]);
      expect(onlineIds(5)).toEqual([1, 2, 6]);
      expect(onlineIds(6)).toEqual([1, 2, 3, 5]);
    }).pipe(
      Effect.provide(
        RealtimeConnectionsLive.pipe(
          Layer.provide(InMemoryUserLocatorLive),
          Layer.provide(InMemoryPubSubLive),
          Layer.provide(InMemoryPresenceStoreLive),
          Layer.provide(staticPresenceAudience(pairs)),
        ),
      ),
    ),
  );
});

test("introduceContacts sends nothing for an offline newcomer", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const alice = recordingWriter();
      yield* connections.register(1, alice.write);
      alice.received.length = 0;

      yield* connections.introduceContacts([2], [1, 2]);

      expect(alice.received).toEqual([]);
    }),
  );
});

// Issue #660: presence and status used to go to every socket in the
// deployment, including people who'd never interacted with the user.
test("presence transitions reach only sockets of users who share a chat with the user", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const bob = recordingWriter();
      const stranger = recordingWriter();
      yield* connections.register(2, bob.write);
      yield* connections.register(3, stranger.write);
      bob.received.length = 0;
      stranger.received.length = 0;

      const unregisterAlice = yield* connections.register(1, () => Effect.void);
      unregisterAlice();
      yield* Effect.sleep("10 millis");

      expect(bob.received).toEqual([
        JSON.stringify({ type: "presence", userId: 1, online: true }),
        JSON.stringify({ type: "presence", userId: 1, online: false }),
      ]);
      expect(stranger.received).toEqual([]);
    }),
  );
});

test("notifyContacts delivers a status change to the user's contacts and own tabs only", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const aliceOtherTab = recordingWriter();
      const bob = recordingWriter();
      const stranger = recordingWriter();
      yield* connections.register(1, aliceOtherTab.write);
      yield* connections.register(2, bob.write);
      yield* connections.register(3, stranger.write);
      aliceOtherTab.received.length = 0;
      bob.received.length = 0;
      stranger.received.length = 0;

      const event = {
        type: "status_changed",
        userId: 1,
        statusText: "Lunch",
        statusEmoji: null,
        statusExpiresAt: null,
      } as const;
      yield* connections.notifyContacts(1, event);

      expect(aliceOtherTab.received).toEqual([JSON.stringify(event)]);
      expect(bob.received).toEqual([JSON.stringify(event)]);
      expect(stranger.received).toEqual([]);
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

const eventsOfType = (received: string[], type: string) =>
  received
    .map((chunk) => JSON.parse(chunk) as Record<string, unknown>)
    .filter((event) => event.type === type);

test("post reactions reach the post's viewers as one batched frame per socket, latest counts winning (issue #828)", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const watcher = recordingWriter();
      const commenter = recordingWriter();
      const bystander = recordingWriter();
      yield* connections.register(1, watcher.write);
      yield* connections.register(2, commenter.write);
      yield* connections.register(3, bystander.write);
      yield* connections.watchPost(5, watcher.write);
      yield* connections.watchPost(6, watcher.write);
      yield* connections.subscribePost(5, commenter.write);
      yield* Effect.sleep(Duration.millis(FEED_HEAD_TEST_INTERVAL_MS / 2));

      yield* connections.announcePostReactions(5, [{ emoji: "👍", count: 1 }]);
      yield* connections.announcePostReactions(5, [{ emoji: "👍", count: 2 }]);
      yield* connections.announcePostReactions(6, [{ emoji: "😂", count: 1 }]);
      yield* Effect.sleep(Duration.millis(FEED_HEAD_TEST_INTERVAL_MS * 3));

      expect(eventsOfType(watcher.received, "post_reactions")).toEqual([
        {
          type: "post_reactions",
          posts: [
            { postId: 5, reactions: [{ emoji: "👍", count: 2 }] },
            { postId: 6, reactions: [{ emoji: "😂", count: 1 }] },
          ],
        },
      ]);
      expect(eventsOfType(commenter.received, "post_reactions")).toEqual([
        {
          type: "post_reactions",
          posts: [{ postId: 5, reactions: [{ emoji: "👍", count: 2 }] }],
        },
      ]);
      expect(eventsOfType(bystander.received, "post_reactions")).toEqual([]);
    }),
  );
});

test("a post's own change reaches its watchers and comment room, each socket once", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const both = recordingWriter();
      const bystander = recordingWriter();
      yield* connections.register(1, both.write);
      yield* connections.register(3, bystander.write);
      yield* connections.watchPost(5, both.write);
      yield* connections.subscribePost(5, both.write);
      both.received.length = 0;
      bystander.received.length = 0;

      const event = {
        type: "post_changed",
        postId: 5,
        change: "updated",
      } as const;
      yield* connections.notifyPostViewers(5, event);

      expect(both.received).toEqual([JSON.stringify(event)]);
      expect(bystander.received).toEqual([]);
    }),
  );
});

test("comment traffic doesn't reach a socket that only shows the post as a card", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const card = recordingWriter();
      yield* connections.register(1, card.write);
      yield* connections.watchPost(5, card.write);
      card.received.length = 0;

      yield* connections.notifyPostRoom(5, {
        type: "comment_changed",
        postId: 5,
        commentId: 1,
      });

      expect(card.received).toEqual([]);
    }),
  );
});

test("unwatchPost and unregister both stop a card's post events", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const left = recordingWriter();
      const dropped = recordingWriter();
      yield* connections.register(1, left.write);
      const unregister = yield* connections.register(2, dropped.write);
      yield* connections.watchPost(5, left.write);
      yield* connections.watchPost(5, dropped.write);
      yield* connections.unwatchPost(5, left.write);
      unregister();
      left.received.length = 0;
      dropped.received.length = 0;

      yield* connections.notifyPostViewers(5, {
        type: "post_changed",
        postId: 5,
        change: "deleted",
      });

      expect(left.received).toEqual([]);
      expect(dropped.received).toEqual([]);
    }),
  );
});

const feedHeads = (received: string[]) =>
  received
    .map((chunk) => JSON.parse(chunk) as { type: string; postIds?: number[] })
    .filter((event) => event.type === "feed_head");

test("new posts reach feed viewers as one coalesced feed_head per interval (issue #827)", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const feedViewer = recordingWriter();
      const elsewhere = recordingWriter();
      yield* connections.register(1, feedViewer.write);
      yield* connections.register(2, elsewhere.write);
      yield* connections.subscribeRoom(FEED_ROOM, feedViewer.write);
      // Lands between ticks, so the burst below is announced together.
      yield* Effect.sleep(Duration.millis(FEED_HEAD_TEST_INTERVAL_MS / 2));

      yield* connections.announcePost(10);
      yield* connections.announcePost(11);
      yield* connections.announcePost(12);
      yield* Effect.sleep(Duration.millis(FEED_HEAD_TEST_INTERVAL_MS * 3));

      expect(feedHeads(feedViewer.received)).toEqual([
        { type: "feed_head", postIds: [10, 11, 12] },
      ]);
      expect(feedHeads(elsewhere.received)).toEqual([]);
    }),
  );
});

test("a quiet interval sends no feed_head", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const feedViewer = recordingWriter();
      yield* connections.register(1, feedViewer.write);
      yield* connections.subscribeRoom(FEED_ROOM, feedViewer.write);

      yield* Effect.sleep(Duration.millis(FEED_HEAD_TEST_INTERVAL_MS * 3));

      expect(feedHeads(feedViewer.received)).toEqual([]);
    }),
  );
});

test("a burst bigger than one feed_head keeps only the newest ids", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const feedViewer = recordingWriter();
      yield* connections.register(1, feedViewer.write);
      yield* connections.subscribeRoom(FEED_ROOM, feedViewer.write);
      yield* Effect.sleep(Duration.millis(FEED_HEAD_TEST_INTERVAL_MS / 2));

      const total = MAX_FEED_HEAD_POST_IDS + 5;
      for (let id = 1; id <= total; id++) yield* connections.announcePost(id);
      yield* Effect.sleep(Duration.millis(FEED_HEAD_TEST_INTERVAL_MS * 3));

      const ids = feedHeads(feedViewer.received).flatMap((e) => e.postIds!);
      expect(ids.length).toBeLessThanOrEqual(MAX_FEED_HEAD_POST_IDS);
      expect(ids.at(-1)).toBe(total);
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

test("notifyRoom delivers only to connections subscribed to that room", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const watcher = recordingWriter();
      const bystander = recordingWriter();
      yield* connections.register(1, watcher.write);
      yield* connections.register(2, bystander.write);
      yield* connections.subscribeRoom(gameLobbyRoom(5), watcher.write);
      watcher.received.length = 0;
      bystander.received.length = 0;

      yield* connections.notifyRoom(gameLobbyRoom(5), {
        type: "game_lobby_updated",
        lobbyId: 5,
      });
      yield* connections.notifyRoom(gameLobbyRoom(6), {
        type: "game_lobby_updated",
        lobbyId: 6,
      });

      expect(watcher.received).toEqual([
        JSON.stringify({ type: "game_lobby_updated", lobbyId: 5 }),
      ]);
      expect(bystander.received).toEqual([]);
    }),
  );
});

test("one connection can only be in so many rooms at once", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const flooder = recordingWriter();
      yield* connections.register(1, flooder.write);
      for (let id = 1; id <= MAX_ROOMS_PER_CONNECTION + 5; id++) {
        yield* connections.subscribeRoom(gameLobbyRoom(id), flooder.write);
      }
      for (let id = 1; id <= MAX_POST_ROOMS_PER_CONNECTION + 5; id++) {
        yield* connections.subscribePost(id, flooder.write);
      }
      // Joins past the cap are dropped...
      expect(
        yield* connections.isInRoom(
          gameLobbyRoom(MAX_ROOMS_PER_CONNECTION),
          flooder.write,
        ),
      ).toBe(true);
      expect(
        yield* connections.isInRoom(
          gameLobbyRoom(MAX_ROOMS_PER_CONNECTION + 1),
          flooder.write,
        ),
      ).toBe(false);
      flooder.received.length = 0;
      yield* connections.notifyPostRoom(MAX_POST_ROOMS_PER_CONNECTION + 1, {
        type: "comment_changed",
        postId: MAX_POST_ROOMS_PER_CONNECTION + 1,
        commentId: 1,
      });
      expect(flooder.received).toEqual([]);

      // ...until leaving one frees a place.
      yield* connections.unsubscribeRoom(gameLobbyRoom(1), flooder.write);
      const late = gameLobbyRoom(MAX_ROOMS_PER_CONNECTION + 1);
      yield* connections.subscribeRoom(late, flooder.write);
      expect(yield* connections.isInRoom(late, flooder.write)).toBe(true);

      // The cap is per connection, not per room.
      const other = recordingWriter();
      yield* connections.register(2, other.write);
      yield* connections.subscribeRoom(late, other.write);
      expect(yield* connections.isInRoom(late, other.write)).toBe(true);
    }),
  );
});

test("unregister sweeps a connection out of every room it had joined", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const watcher = recordingWriter();
      const unregister = yield* connections.register(1, watcher.write);
      yield* connections.subscribeRoom(gameHubRoom("typing"), watcher.write);
      expect(
        yield* connections.isInRoom(gameHubRoom("typing"), watcher.write),
      ).toBe(true);

      unregister();

      expect(
        yield* connections.isInRoom(gameHubRoom("typing"), watcher.write),
      ).toBe(false);
    }),
  );
});

test("isValidRoomName only admits the feed and the games' room shapes", () => {
  expect(isValidRoomName("feed")).toBe(true);
  expect(isValidRoomName("feeds")).toBe(false);
  expect(isValidRoomName("game-hub:typing")).toBe(true);
  expect(isValidRoomName("game-lobby:42")).toBe(true);
  expect(isValidRoomName("game-lobby:abc")).toBe(false);
  expect(isValidRoomName("game-hub:Typing")).toBe(false);
  expect(isValidRoomName("chat:1")).toBe(false);
  expect(isValidRoomName(42)).toBe(false);
});

// The socket's incoming-frame handler (RealtimeSocket.ts), driven directly
// with a recording writer standing in for the upgraded socket.
test("game_progress is relayed to the lobby room, stamped with the sender's own id", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const racer = recordingWriter();
      const opponent = recordingWriter();
      yield* connections.register(1, racer.write);
      yield* connections.register(2, opponent.write);
      const fromRacer = makeIncomingHandler(connections, 1, racer.write);
      const fromOpponent = makeIncomingHandler(connections, 2, opponent.write);

      // Not yet watching the lobby: nothing is relayed.
      yield* fromRacer(
        JSON.stringify({ type: "game_progress", lobbyId: 9, progress: 3 }),
      );
      expect(opponent.received).not.toContainEqual(
        expect.stringContaining("game_progress"),
      );

      for (const handler of [fromRacer, fromOpponent]) {
        yield* handler(
          JSON.stringify({ type: "subscribe_room", room: gameLobbyRoom(9) }),
        );
      }
      racer.received.length = 0;
      opponent.received.length = 0;

      // A spoofed `userId` in the frame is ignored — the socket's own wins.
      yield* fromRacer(
        JSON.stringify({
          type: "game_progress",
          lobbyId: 9,
          progress: 12,
          userId: 2,
        }),
      );
      const relayed = JSON.stringify({
        type: "game_progress",
        lobbyId: 9,
        userId: 1,
        progress: 12,
      });
      expect(opponent.received).toEqual([relayed]);
      expect(racer.received).toEqual([relayed]);

      // Malformed frames and unknown rooms are dropped.
      yield* fromRacer(
        JSON.stringify({ type: "game_progress", lobbyId: 9, progress: -1 }),
      );
      yield* fromRacer(
        JSON.stringify({ type: "subscribe_room", room: "anything:1" }),
      );
      yield* fromRacer("not json");
      expect(opponent.received).toHaveLength(1);
    }),
  );
});

test("game_progress frames beyond the per-second budget are dropped", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const racer = recordingWriter();
      yield* connections.register(1, racer.write);
      const handle = makeIncomingHandler(connections, 1, racer.write);
      yield* handle(
        JSON.stringify({ type: "subscribe_room", room: gameLobbyRoom(3) }),
      );
      racer.received.length = 0;

      for (let progress = 0; progress < 40; progress++) {
        yield* handle(
          JSON.stringify({ type: "game_progress", lobbyId: 3, progress }),
        );
      }
      expect(racer.received.length).toBeGreaterThan(0);
      expect(racer.received.length).toBeLessThan(40);
    }),
  );
});

test("game_reaction relays only the fixed emoji, stamped with the sender's id and budgeted", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const fan = recordingWriter();
      const player = recordingWriter();
      yield* connections.register(1, fan.write);
      yield* connections.register(2, player.write);
      const fromFan = makeIncomingHandler(connections, 1, fan.write);
      const fromPlayer = makeIncomingHandler(connections, 2, player.write);

      // Not watching the lobby yet: nothing is relayed.
      yield* fromFan(
        JSON.stringify({ type: "game_reaction", lobbyId: 4, reaction: "🔥" }),
      );
      for (const handler of [fromFan, fromPlayer]) {
        yield* handler(
          JSON.stringify({ type: "subscribe_room", room: gameLobbyRoom(4) }),
        );
      }
      fan.received.length = 0;
      player.received.length = 0;

      yield* fromFan(
        JSON.stringify({
          type: "game_reaction",
          lobbyId: 4,
          reaction: "🔥",
          userId: 2,
        }),
      );
      expect(player.received).toEqual([
        JSON.stringify({
          type: "game_reaction",
          lobbyId: 4,
          userId: 1,
          reaction: "🔥",
        }),
      ]);

      // Anything outside the set — words included — is dropped.
      yield* fromFan(
        JSON.stringify({ type: "game_reaction", lobbyId: 4, reaction: "cat" }),
      );
      yield* fromFan(
        JSON.stringify({ type: "game_reaction", lobbyId: 4, reaction: 1 }),
      );
      expect(player.received).toHaveLength(1);

      for (let i = 0; i < 20; i++) {
        yield* fromFan(
          JSON.stringify({ type: "game_reaction", lobbyId: 4, reaction: "👏" }),
        );
      }
      expect(player.received.length).toBeGreaterThan(1);
      expect(player.received.length).toBeLessThan(21);
    }),
  );
});

// A connection whose `close` handle records that it was called, standing in
// for a real socket's close (see `register` in Realtime.ts).
const closableConnection = () => {
  const { write, received } = recordingWriter();
  const state = { closed: 0, codes: [] as number[] };
  const close = (code: number) =>
    Effect.sync(() => {
      state.closed++;
      state.codes.push(code);
    });
  return { write, received, close, state };
};

test("disconnectUser closes every connection of that user and no one else's (issue #651)", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const tabA = closableConnection();
      const tabB = closableConnection();
      const bob = closableConnection();
      yield* connections.register(1, tabA.write, tabA.close);
      yield* connections.register(1, tabB.write, tabB.close);
      yield* connections.register(2, bob.write, bob.close);

      yield* connections.disconnectUser(1);

      expect(tabA.state.closed).toBe(1);
      expect(tabB.state.closed).toBe(1);
      expect(bob.state.closed).toBe(0);
    }),
  );
});

test("a disconnected user's sockets stop receiving events before their close lands", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const alice = closableConnection();
      const bob = closableConnection();
      yield* connections.register(1, alice.write, alice.close);
      yield* connections.register(2, bob.write, bob.close);
      alice.received.length = 0;
      bob.received.length = 0;

      yield* connections.disconnectUser(1);
      yield* connections.notifyUsers([1, 2], {
        type: "chat_updated",
        chatId: 3,
        version: 1,
      });
      yield* connections.broadcastAll({
        type: "post_changed",
        postId: 9,
        change: "created",
      });

      expect(alice.received).toEqual([]);
      expect(bob.received).toHaveLength(2);
    }),
  );
});

test("disconnectUser leaves a connection made afterwards alone", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const before = closableConnection();
      const unregister = yield* connections.register(
        1,
        before.write,
        before.close,
      );
      yield* connections.disconnectUser(1);
      unregister();

      // The session that made the change reconnects with fresh tokens.
      const after = closableConnection();
      yield* connections.register(1, after.write, after.close);
      after.received.length = 0;
      yield* connections.notifyUsers([1], {
        type: "chat_updated",
        chatId: 1,
        version: 1,
      });

      expect(before.state.closed).toBe(1);
      expect(after.state.closed).toBe(0);
      expect(after.received).toHaveLength(1);
    }),
  );
});

test("a failing close doesn't stop the user's other connections from closing", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const broken = recordingWriter();
      const tab = closableConnection();
      yield* connections.register(1, broken.write, () => Effect.fail("gone"));
      yield* connections.register(1, tab.write, tab.close);

      yield* connections.disconnectUser(1);

      expect(tab.state.closed).toBe(1);
    }),
  );
});

// Issue #832: two instances sharing one PubSub (spied on) and one directory,
// as two replicas share Redis.
const twoInstances = (config: Layer.Layer<never> = Layer.empty) =>
  Effect.gen(function* () {
    const base = yield* Effect.service(PubSub).pipe(
      Effect.provide(InMemoryPubSubLive),
    );
    const published: Array<{ channel: string; message: string }> = [];
    // Channels subscribed (+) and unsubscribed (-), in order.
    const subscriptions: string[] = [];
    const spy = {
      ...base,
      publish: (channel: string, message: string) =>
        Effect.sync(() => {
          published.push({ channel, message });
        }).pipe(Effect.andThen(base.publish(channel, message))),
      subscribe: (
        channel: string,
        onMessage: (message: string) => Effect.Effect<void>,
      ) =>
        Effect.sync(() => {
          subscriptions.push(`+${channel}`);
        }).pipe(Effect.andThen(base.subscribe(channel, onMessage))),
      unsubscribe: (channel: string) =>
        Effect.sync(() => {
          subscriptions.push(`-${channel}`);
        }).pipe(Effect.andThen(base.unsubscribe(channel))),
    };
    const locator = makeInMemoryUserLocator();
    const instance = Effect.service(RealtimeConnections).pipe(
      Effect.provide(
        RealtimeConnectionsLive.pipe(
          Layer.provide(Layer.succeed(PubSub, spy)),
          Layer.provide(Layer.succeed(UserLocator, locator)),
          Layer.provide(InMemoryPresenceStoreLive),
          Layer.provide(staticPresenceAudience([])),
          Layer.provide(config),
        ),
      ),
    );
    return {
      a: yield* instance,
      b: yield* instance,
      pubsub: base,
      published,
      subscriptions,
    };
  });

const chatEvent = { type: "chat_updated", chatId: 9, version: 1 } as const;

test("a user event is published only to the instances holding its recipients, each with just its own (issue #832)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { a, b, published } = yield* twoInstances();
      const onA = recordingWriter();
      const onB = recordingWriter();
      yield* a.register(1, onA.write);
      yield* b.register(2, onB.write);
      onA.received.length = 0;
      onB.received.length = 0;
      published.length = 0;

      // User 3 is connected nowhere.
      yield* b.notifyUsers([1, 2, 3], chatEvent);

      expect(onA.received).toEqual([JSON.stringify(chatEvent)]);
      expect(onB.received).toEqual([JSON.stringify(chatEvent)]);
      const routed = published
        .filter((p) => p.channel.startsWith("chat-platform:realtime:instance:"))
        .map((p) => (JSON.parse(p.message) as { userIds: number[] }).userIds)
        .sort((x, y) => x[0]! - y[0]!);
      expect(routed).toEqual([[1], [2]]);
      // Nothing on the shared channel, which every instance listens on.
      expect(
        published.filter((p) => p.channel === "chat-platform:realtime"),
      ).toEqual([]);
    }),
  );
});

test("an event for users connected nowhere publishes nothing to any instance", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { b, published } = yield* twoInstances();
      published.length = 0;
      yield* b.notifyUsers([41, 42], chatEvent);
      expect(
        published.filter((p) =>
          p.channel.startsWith("chat-platform:realtime:instance:"),
        ),
      ).toEqual([]);
    }),
  );
});

test("a routed copy an instance mid-rollout puts on the shared channel is skipped, not delivered twice", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { a, pubsub } = yield* twoInstances();
      const socket = recordingWriter();
      yield* a.register(1, socket.write);
      socket.received.length = 0;
      // What 0.41.5–0.41.9 published next to the routed copy.
      yield* pubsub.publish(
        "chat-platform:realtime",
        `{"routed":true,${JSON.stringify({ scope: "users", userIds: [1], event: chatEvent }).slice(1)}`,
      );
      expect(socket.received).toEqual([]);
    }),
  );
});

test("an event published the old way on the shared channel still reaches the user (mid-rollout)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const base = yield* Effect.service(PubSub).pipe(
        Effect.provide(InMemoryPubSubLive),
      );
      const connections = yield* Effect.service(RealtimeConnections).pipe(
        Effect.provide(
          RealtimeConnectionsLive.pipe(
            Layer.provide(Layer.succeed(PubSub, base)),
            Layer.provide(InMemoryUserLocatorLive),
            Layer.provide(InMemoryPresenceStoreLive),
            Layer.provide(staticPresenceAudience([])),
          ),
        ),
      );
      const socket = recordingWriter();
      yield* connections.register(1, socket.write);
      socket.received.length = 0;
      // What an instance that predates routing publishes.
      yield* base.publish(
        "chat-platform:realtime",
        JSON.stringify({ scope: "users", userIds: [1], event: chatEvent }),
      );
      expect(socket.received).toEqual([JSON.stringify(chatEvent)]);
    }),
  );
});

const ROOM_LINGER_MS = 30;
const shortLinger = Layer.succeed(
  RoomChannelLinger,
  Duration.millis(ROOM_LINGER_MS),
);
const postChannels = (subscriptions: ReadonlyArray<string>) =>
  subscriptions.filter((s) => s.includes("chat-platform:realtime:post:"));
const sleepMs = (ms: number) => Effect.sleep(Duration.millis(ms));

test("a post's events go to its own channel, which only instances showing it listen on (issue #832)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { a, b, published, subscriptions } =
        yield* twoInstances(shortLinger);
      const card = recordingWriter();
      const comments = recordingWriter();
      yield* a.watchPost(5, card.write);
      yield* a.subscribePost(5, comments.write);
      published.length = 0;

      const event = {
        type: "comment_changed",
        postId: 5,
        commentId: 1,
      } as const;
      yield* b.notifyPostRoom(5, event);
      yield* b.notifyPostViewers(5, {
        type: "post_changed",
        postId: 5,
        change: "deleted",
      });

      expect(comments.received).toEqual([
        JSON.stringify(event),
        JSON.stringify({ type: "post_changed", postId: 5, change: "deleted" }),
      ]);
      expect(card.received).toEqual([
        JSON.stringify({ type: "post_changed", postId: 5, change: "deleted" }),
      ]);
      // One subscription on A for both, none on B, which shows nothing.
      expect(postChannels(subscriptions)).toEqual([
        "+chat-platform:realtime:post:5",
      ]);
      expect(
        published
          .filter((p) => p.channel !== "chat-platform:realtime")
          .map((p) => p.channel),
      ).toEqual([
        "chat-platform:realtime:post:5",
        "chat-platform:realtime:post:5",
      ]);
      expect(
        published.filter((p) => p.channel === "chat-platform:realtime"),
      ).toEqual([]);
    }),
  );
});

test("a room's events reach only the instances with a socket in it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { a, b, subscriptions } = yield* twoInstances(shortLinger);
      const player = recordingWriter();
      const room = gameLobbyRoom(3);
      yield* a.subscribeRoom(room, player.write);
      const event = { type: "game_lobby_updated", lobbyId: 3 } as const;
      yield* b.notifyRoom(room, event);
      expect(player.received).toEqual([JSON.stringify(event)]);
      expect(
        subscriptions.filter((s) => s.includes(":realtime:room:")),
      ).toEqual([`+chat-platform:realtime:room:${room}`]);
    }),
  );
});

test("a post's channel lingers after its last viewer leaves, and a viewer back in time keeps it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { a, subscriptions } = yield* twoInstances(shortLinger);
      const first = recordingWriter();
      const second = recordingWriter();
      yield* a.watchPost(5, first.write);
      yield* a.subscribePost(5, first.write);
      yield* a.unwatchPost(5, first.write);
      // Still in its comments: held.
      yield* sleepMs(ROOM_LINGER_MS * 3);
      expect(postChannels(subscriptions)).toEqual([
        "+chat-platform:realtime:post:5",
      ]);

      yield* a.unsubscribePost(5, first.write);
      yield* a.watchPost(5, second.write);
      yield* sleepMs(ROOM_LINGER_MS * 3);
      expect(postChannels(subscriptions)).toEqual([
        "+chat-platform:realtime:post:5",
      ]);

      yield* a.unwatchPost(5, second.write);
      yield* sleepMs(ROOM_LINGER_MS * 3);
      expect(postChannels(subscriptions)).toEqual([
        "+chat-platform:realtime:post:5",
        "-chat-platform:realtime:post:5",
      ]);

      // Showing it again listens again.
      yield* a.watchPost(5, second.write);
      expect(postChannels(subscriptions)).toEqual([
        "+chat-platform:realtime:post:5",
        "-chat-platform:realtime:post:5",
        "+chat-platform:realtime:post:5",
      ]);
    }),
  );
});

test("a closed socket releases the post and room channels it held", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { a, subscriptions } = yield* twoInstances(shortLinger);
      const socket = recordingWriter();
      const unregister = yield* a.register(1, socket.write);
      yield* a.watchPost(5, socket.write);
      yield* a.subscribeRoom(gameHubRoom("typing"), socket.write);
      unregister();
      yield* sleepMs(ROOM_LINGER_MS * 3);
      expect(subscriptions.filter((s) => s.startsWith("-"))).toEqual([
        "-chat-platform:realtime:post:5",
        "-chat-platform:realtime:room:game-hub:typing",
      ]);
    }),
  );
});

test("a post event published the old way on the shared channel still reaches its viewers (mid-rollout)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const base = yield* Effect.service(PubSub).pipe(
        Effect.provide(InMemoryPubSubLive),
      );
      const connections = yield* Effect.service(RealtimeConnections).pipe(
        Effect.provide(
          RealtimeConnectionsLive.pipe(
            Layer.provide(Layer.succeed(PubSub, base)),
            Layer.provide(InMemoryUserLocatorLive),
            Layer.provide(InMemoryPresenceStoreLive),
            Layer.provide(staticPresenceAudience([])),
          ),
        ),
      );
      const card = recordingWriter();
      yield* connections.watchPost(5, card.write);
      const event = {
        type: "post_changed",
        postId: 5,
        change: "deleted",
      } as const;
      yield* base.publish(
        "chat-platform:realtime",
        JSON.stringify({ scope: "post_viewers", postId: 5, event }),
      );
      expect(card.received).toEqual([JSON.stringify(event)]);
    }),
  );
});

test("disconnectUser closes the user's sockets on the instance holding them", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { a, b } = yield* twoInstances();
      const tab = closableConnection();
      yield* a.register(7, tab.write, tab.close);
      yield* b.disconnectUser(7);
      expect(tab.state.closed).toBe(1);
    }),
  );
});

test("drain closes every connection with the draining code within the window, and flags the instance (issue #836)", async () => {
  await run(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const sockets = [1, 2, 3].map(() => closableConnection());
      for (const [i, socket] of sockets.entries()) {
        yield* connections.register(i + 1, socket.write, socket.close);
      }
      expect(yield* connections.isDraining).toBe(false);

      const startedAt = Date.now();
      yield* connections.drain(Duration.millis(100));

      expect(yield* connections.isDraining).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      for (const socket of sockets) {
        expect(socket.state.codes).toEqual([SERVER_DRAINING_CLOSE_CODE]);
      }
    }),
  );
});
