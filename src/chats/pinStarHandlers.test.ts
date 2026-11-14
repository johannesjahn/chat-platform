import { expect, test } from "bun:test";
import { Effect } from "effect";
import { makeTestRun } from "../testApi.ts";
import { registerAndLogin } from "./testKit.ts";

const run = makeTestRun();

// --- Pinned & starred messages (issue #223) ---------------------------------

test("a new message starts unpinned and unstarred", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "hi bob" },
      });
      expect(message.pinned).toBe(false);
      expect(message.starred).toBe(false);

      const pins = yield* alice.client.chats.listPinnedMessages({
        params: { id: chat.id },
      });
      expect(pins).toEqual([]);
    }),
  ));

test("pinMessage/unpinMessage toggle chat-wide pin state, visible to every participant", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "important" },
      });

      // Any participant may pin, not just the sender.
      const pinned = yield* bob.client.chats.pinMessage({
        params: { id: chat.id },
        payload: { messageId: message.id },
      });
      expect(pinned.pinned).toBe(true);

      // The pin is chat-wide: the *other* participant sees it in the thread
      // and in the pinned list.
      const listed = yield* alice.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      expect(listed.messages.find((m) => m.id === message.id)!.pinned).toBe(
        true,
      );
      const pins = yield* alice.client.chats.listPinnedMessages({
        params: { id: chat.id },
      });
      expect(pins.map((m) => m.id)).toEqual([message.id]);
      expect(pins[0]!.pinned).toBe(true);

      const unpinned = yield* alice.client.chats.unpinMessage({
        params: { id: chat.id, messageId: message.id },
      });
      expect(unpinned.pinned).toBe(false);
      const afterUnpin = yield* alice.client.chats.listPinnedMessages({
        params: { id: chat.id },
      });
      expect(afterUnpin).toEqual([]);
    }),
  ));

test("pinMessage is idempotent, and the pinned list is newest-pin-first", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const first = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "first" },
      });
      const second = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "second" },
      });

      yield* alice.client.chats.pinMessage({
        params: { id: chat.id },
        payload: { messageId: first.id },
      });
      // Re-pinning the same message is a no-op, not a duplicate.
      yield* alice.client.chats.pinMessage({
        params: { id: chat.id },
        payload: { messageId: first.id },
      });
      yield* alice.client.chats.pinMessage({
        params: { id: chat.id },
        payload: { messageId: second.id },
      });

      const pins = yield* alice.client.chats.listPinnedMessages({
        params: { id: chat.id },
      });
      // `second` was pinned last, so it surfaces first.
      expect(pins.map((m) => m.id)).toEqual([second.id, first.id]);
    }),
  ));

test("pinMessage is forbidden for non-participants and 404s for a message in another chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const eve = yield* registerAndLogin("eve", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "hi bob" },
      });

      const forbidden = yield* eve.client.chats
        .pinMessage({
          params: { id: chat.id },
          payload: { messageId: message.id },
        })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      const notFound = yield* alice.client.chats
        .pinMessage({
          params: { id: chat.id },
          payload: { messageId: 9999 },
        })
        .pipe(Effect.flip);
      expect(notFound._tag).toBe("NotFound");
    }),
  ));

test("starMessage/unstarMessage are private per-user bookmarks", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "bookmark me" },
      });

      const starred = yield* alice.client.chats.starMessage({
        params: { id: chat.id, messageId: message.id },
      });
      expect(starred.starred).toBe(true);

      // Alice sees her own star both in the thread and in her starred list.
      const aliceView = yield* alice.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      expect(aliceView.messages.find((m) => m.id === message.id)!.starred).toBe(
        true,
      );
      const aliceStars = yield* alice.client.chats.listStarredMessages({
        params: { id: chat.id },
      });
      expect(aliceStars.map((m) => m.id)).toEqual([message.id]);

      // Bob, a participant of the same chat, never sees Alice's star — a star
      // is private (and never pinned it either).
      const bobView = yield* bob.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      const bobSeen = bobView.messages.find((m) => m.id === message.id)!;
      expect(bobSeen.starred).toBe(false);
      expect(bobSeen.pinned).toBe(false);
      const bobStars = yield* bob.client.chats.listStarredMessages({
        params: { id: chat.id },
      });
      expect(bobStars).toEqual([]);

      const unstarred = yield* alice.client.chats.unstarMessage({
        params: { id: chat.id, messageId: message.id },
      });
      expect(unstarred.starred).toBe(false);
      const afterUnstar = yield* alice.client.chats.listStarredMessages({
        params: { id: chat.id },
      });
      expect(afterUnstar).toEqual([]);
    }),
  ));

test("starMessage is idempotent and forbidden for non-participants", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const eve = yield* registerAndLogin("eve", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "hi bob" },
      });

      yield* alice.client.chats.starMessage({
        params: { id: chat.id, messageId: message.id },
      });
      // Re-starring is a no-op, not a duplicate.
      yield* alice.client.chats.starMessage({
        params: { id: chat.id, messageId: message.id },
      });
      const stars = yield* alice.client.chats.listStarredMessages({
        params: { id: chat.id },
      });
      expect(stars.map((m) => m.id)).toEqual([message.id]);

      const forbidden = yield* eve.client.chats
        .starMessage({ params: { id: chat.id, messageId: message.id } })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");
    }),
  ));

test("deleting a pinned-and-starred message removes it from both lists", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "temporary" },
      });
      yield* alice.client.chats.pinMessage({
        params: { id: chat.id },
        payload: { messageId: message.id },
      });
      yield* alice.client.chats.starMessage({
        params: { id: chat.id, messageId: message.id },
      });

      yield* alice.client.chats.deleteMessage({
        params: { id: chat.id, messageId: message.id },
      });

      // The pin/star rows cascade with the message (FK onDelete cascade).
      const pins = yield* alice.client.chats.listPinnedMessages({
        params: { id: chat.id },
      });
      expect(pins).toEqual([]);
      const stars = yield* alice.client.chats.listStarredMessages({
        params: { id: chat.id },
      });
      expect(stars).toEqual([]);
    }),
  ));
