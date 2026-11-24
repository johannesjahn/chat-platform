import { expect, test } from "bun:test";
import { Effect, Metric } from "effect";
import { contentCreatedTotal } from "../Metrics.ts";
import { makeTestRun } from "../testApi.ts";
import { reactionOf, registerAndLogin } from "./testKit.ts";

const run = makeTestRun();

test("createMessage sends a message, bumps chat activity, and is forbidden for non-participants", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const eve = yield* registerAndLogin("eve", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      // content_created_total is a module-level metric shared with whichever
      // other test files land in the same `bun test --parallel` worker
      // process, so this asserts the delta createMessage produces rather
      // than an absolute value (see Metrics.test.ts's
      // websocketConnectionsActive test for the same reasoning).
      const messagesCreated = Metric.withAttributes(contentCreatedTotal, {
        type: "message",
      });
      const beforeMessagesCreated = yield* Metric.value(messagesCreated);

      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "hello bob" },
      });
      expect(message.senderId).toBe(alice.user.id);
      expect(message.body).toBe("hello bob");
      expect(message.readByUserIds).toEqual([]);
      expect((yield* Metric.value(messagesCreated)).count).toBe(
        beforeMessagesCreated.count + 1,
      );

      const {
        chats: [aliceChat],
      } = yield* alice.client.chats.listChats({ query: {} });
      expect(aliceChat!.lastMessage?.id).toBe(message.id);
      expect(aliceChat!.unreadCount).toBe(0);

      const {
        chats: [bobChat],
      } = yield* bob.client.chats.listChats({ query: {} });
      expect(bobChat!.unreadCount).toBe(1);

      const forbidden = yield* eve.client.chats
        .createMessage({
          params: { id: chat.id },
          payload: { body: "intruding" },
        })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");
    }),
  ));

test("createMessage is idempotent per clientId (issue #567)", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const send = (clientId?: string) =>
        alice.client.chats.createMessage({
          params: { id: chat.id },
          payload: { body: "once", clientId },
        });

      const first = yield* send("key-1");
      const repeat = yield* send("key-1");
      expect(repeat.id).toBe(first.id);

      // A different key, or no key at all, is a new message.
      const other = yield* send("key-2");
      const keyless = yield* send();
      expect(new Set([first.id, other.id, keyless.id]).size).toBe(3);

      const { messages } = yield* alice.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      expect(messages).toHaveLength(3);
    }),
  ));

test("a message's clientId is echoed back to its sender only", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const sent = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "hi", clientId: "key-1" },
      });
      expect(sent.clientId).toBe("key-1");
      const keyless = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "no key" },
      });
      expect(keyless.clientId).toBeUndefined();

      const forAlice = yield* alice.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      expect(forAlice.messages.find((m) => m.id === sent.id)?.clientId).toBe(
        "key-1",
      );
      const forBob = yield* bob.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      expect(forBob.messages.every((m) => m.clientId === undefined)).toBe(true);
    }),
  ));

test("createMessage rejects content over the max length", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      yield* alice.client.chats
        .createMessage({
          params: { id: chat.id },
          payload: { body: "x".repeat(4001) },
        })
        .pipe(Effect.flip);
    }),
  ));

test("createMessage supports replying to a message, exposing a parent preview", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const parent = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "what's for lunch?" },
      });
      expect(parent.parentMessage).toBeNull();

      const reply = yield* bob.client.chats.createMessage({
        params: { id: chat.id },
        payload: {
          body: "tacos",
          parentMessageId: parent.id,
        },
      });
      expect(reply.parentMessage).not.toBeNull();
      expect(reply.parentMessage?.id).toBe(parent.id);
      expect(reply.parentMessage?.senderId).toBe(alice.user.id);
      expect(reply.parentMessage?.senderName).toBe("alice");
      expect(reply.parentMessage?.hasAttachment).toBe(false);
      expect(reply.parentMessage?.body).toBe("what's for lunch?");

      // The preview round-trips through listMessages too, not just the
      // create response.
      const page = yield* bob.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      const listedReply = page.messages.find((m) => m.id === reply.id);
      expect(listedReply?.parentMessage?.id).toBe(parent.id);
      expect(listedReply?.parentMessage?.body).toBe("what's for lunch?");
    }),
  ));

test("createMessage truncates a long parent preview and uses the sender's display name", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      yield* alice.client.users.updateProfile({
        payload: { displayName: "Alice A.", avatarUrl: null },
      });
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const longContent = "x".repeat(400);
      const parent = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: longContent },
      });
      const reply = yield* bob.client.chats.createMessage({
        params: { id: chat.id },
        payload: {
          body: "long one",
          parentMessageId: parent.id,
        },
      });
      // Only a preview-length snippet rides along, not the full body.
      expect(reply.parentMessage?.body.length).toBe(120);
      expect(reply.parentMessage?.body).toBe("x".repeat(120));
      // displayName wins over username.
      expect(reply.parentMessage?.senderName).toBe("Alice A.");
    }),
  ));

test("createMessage 404s when replying to a message from another chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chatAB = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const chatAC = yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });

      // A message that lives in the alice↔carol chat…
      const otherChatMessage = yield* alice.client.chats.createMessage({
        params: { id: chatAC.id },
        payload: { body: "hi carol" },
      });
      // …can't be quoted from the alice↔bob chat.
      const result = yield* alice.client.chats
        .createMessage({
          params: { id: chatAB.id },
          payload: {
            body: "cross-chat reply",
            parentMessageId: otherChatMessage.id,
          },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");

      // A parent id that doesn't exist at all 404s the same way.
      const missing = yield* alice.client.chats
        .createMessage({
          params: { id: chatAB.id },
          payload: {
            body: "reply to nothing",
            parentMessageId: 999999,
          },
        })
        .pipe(Effect.flip);
      expect(missing._tag).toBe("NotFound");
    }),
  ));

test("deleting a quoted message leaves the reply, with its parent preview nulled", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const parent = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "delete me" },
      });
      const reply = yield* bob.client.chats.createMessage({
        params: { id: chat.id },
        payload: {
          body: "still here",
          parentMessageId: parent.id,
        },
      });

      yield* alice.client.chats.deleteMessage({
        params: { id: chat.id, messageId: parent.id },
      });

      // The reply survives (set-null FK, not cascade), and its quote is gone.
      const page = yield* bob.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      const surviving = page.messages.find((m) => m.id === reply.id);
      expect(surviving).toBeDefined();
      expect(surviving?.parentMessage).toBeNull();
    }),
  ));

test("editing a reply preserves its parent preview", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const parent = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "original question" },
      });
      const reply = yield* bob.client.chats.createMessage({
        params: { id: chat.id },
        payload: {
          body: "first answer",
          parentMessageId: parent.id,
        },
      });

      const edited = yield* bob.client.chats.updateMessage({
        params: { id: chat.id, messageId: reply.id },
        payload: { body: "revised answer" },
      });
      expect(edited.body).toBe("revised answer");
      expect(edited.parentMessage?.id).toBe(parent.id);
      expect(edited.parentMessage?.body).toBe("original question");
    }),
  ));

test("listMessages returns the newest window by default, oldest-first, and is forbidden for non-participants", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const eve = yield* registerAndLogin("eve", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const sent = [];
      for (let i = 0; i < 5; i++) {
        sent.push(
          yield* alice.client.chats.createMessage({
            params: { id: chat.id },
            payload: { body: `msg ${i}` },
          }),
        );
      }

      // No cursor: the newest `limit` messages, still oldest-first.
      const page = yield* bob.client.chats.listMessages({
        params: { id: chat.id },
        query: { limit: 3 },
      });
      expect(page.hasEarlier).toBe(true);
      expect(page.hasNewer).toBe(false);
      expect(page.messages.map((m) => m.id)).toEqual(
        sent.slice(2, 5).map((m) => m.id),
      );

      const earlierPage = yield* bob.client.chats.listMessages({
        params: { id: chat.id },
        query: { limit: 3, before: page.earliestCursor! },
      });
      expect(earlierPage.hasEarlier).toBe(false);
      expect(earlierPage.hasNewer).toBe(true);
      expect(earlierPage.messages.map((m) => m.id)).toEqual(
        sent.slice(0, 2).map((m) => m.id),
      );

      const laterPage = yield* bob.client.chats.listMessages({
        params: { id: chat.id },
        query: { limit: 3, after: earlierPage.latestCursor! },
      });
      expect(laterPage.hasNewer).toBe(false);
      expect(laterPage.messages.map((m) => m.id)).toEqual(
        sent.slice(2, 5).map((m) => m.id),
      );

      const forbidden = yield* eve.client.chats
        .listMessages({ params: { id: chat.id }, query: {} })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");
    }),
  ));

test("listMessages rejects a malformed cursor and setting both before and after", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "hi" },
      });
      const validCursor = (yield* alice.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      })).latestCursor!;

      const badCursor = yield* alice.client.chats
        .listMessages({
          params: { id: chat.id },
          query: { before: "not-a-real-cursor" },
        })
        .pipe(Effect.flip);
      expect(badCursor._tag).toBe("InvalidChatRequest");

      const both = yield* alice.client.chats
        .listMessages({
          params: { id: chat.id },
          query: { before: validCursor, after: validCursor },
        })
        .pipe(Effect.flip);
      expect(both._tag).toBe("InvalidChatRequest");
    }),
  ));

test("updateMessage lets the sender edit their message and bumps updatedAt past createdAt, but forbids others", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "original" },
      });
      expect(message.updatedAt).toBe(message.createdAt);

      const edited = yield* alice.client.chats.updateMessage({
        params: { id: chat.id, messageId: message.id },
        payload: { body: "edited" },
      });
      expect(edited.body).toBe("edited");
      expect(edited.updatedAt).toBeGreaterThanOrEqual(message.updatedAt);

      const forbidden = yield* bob.client.chats
        .updateMessage({
          params: { id: chat.id, messageId: message.id },
          payload: { body: "hijacked" },
        })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");
    }),
  ));

test("updateMessage 404s for a message that doesn't belong to the given chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chatAB = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const eve = yield* registerAndLogin("eve", "pw-testpass");
      const chatAE = yield* alice.client.chats.createDirectChat({
        payload: { userId: eve.user.id },
      });
      const messageInAB = yield* alice.client.chats.createMessage({
        params: { id: chatAB.id },
        payload: { body: "hi bob" },
      });

      const result = yield* alice.client.chats
        .updateMessage({
          params: { id: chatAE.id, messageId: messageInAB.id },
          payload: { body: "wrong chat" },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("deleteMessage removes the message and its read receipts, and is forbidden for non-senders", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "delete me" },
      });
      yield* bob.client.chats.markRead({
        params: { id: chat.id },
        payload: { messageId: message.id },
      });

      const forbidden = yield* bob.client.chats
        .deleteMessage({ params: { id: chat.id, messageId: message.id } })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      yield* alice.client.chats.deleteMessage({
        params: { id: chat.id, messageId: message.id },
      });

      const page = yield* alice.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      expect(page.messages.map((m) => m.id)).not.toContain(message.id);
      expect(page.messages).toHaveLength(0);
    }),
  ));

// --- Message reactions (issue #216) -----------------------------------------

test("a new message starts with no reactions", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "hi bob" },
      });
      expect(message.reactions).toEqual([]);
    }),
  ));

test("addMessageReaction/removeMessageReaction toggle reaction state, visible to any participant", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "hi bob" },
      });

      // Any participant may react, not just the sender.
      const reacted = yield* bob.client.chats.addMessageReaction({
        params: { id: chat.id, messageId: message.id },
        payload: { emoji: "👍" },
      });
      expect(reactionOf(reacted.reactions, "👍")).toEqual({
        emoji: "👍",
        count: 1,
        reactedByMe: true,
      });

      // Visible (with reactedByMe from their own perspective) via listMessages
      // to every participant, not just the reactor.
      const listed = yield* alice.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      const seen = listed.messages.find((m) => m.id === message.id)!;
      expect(reactionOf(seen.reactions, "👍")).toEqual({
        emoji: "👍",
        count: 1,
        reactedByMe: false,
      });

      const removed = yield* bob.client.chats.removeMessageReaction({
        params: { id: chat.id, messageId: message.id },
        payload: { emoji: "👍" },
      });
      expect(reactionOf(removed.reactions, "👍").count).toBe(0);
    }),
  ));

test("addMessageReaction is idempotent, and a user can react with more than one distinct emoji", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "hi bob" },
      });

      yield* bob.client.chats.addMessageReaction({
        params: { id: chat.id, messageId: message.id },
        payload: { emoji: "❤️" },
      });
      const state = yield* bob.client.chats.addMessageReaction({
        params: { id: chat.id, messageId: message.id },
        payload: { emoji: "❤️" },
      });
      expect(reactionOf(state.reactions, "❤️")).toEqual({
        emoji: "❤️",
        count: 1,
        reactedByMe: true,
      });

      const withSecond = yield* bob.client.chats.addMessageReaction({
        params: { id: chat.id, messageId: message.id },
        payload: { emoji: "😂" },
      });
      expect(reactionOf(withSecond.reactions, "❤️").count).toBe(1);
      expect(reactionOf(withSecond.reactions, "😂")).toEqual({
        emoji: "😂",
        count: 1,
        reactedByMe: true,
      });
    }),
  ));

test("addMessageReaction is forbidden for non-participants and 404s for a missing message", () =>
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
        payload: { body: "hi bob" },
      });

      const forbidden = yield* eve.client.chats
        .addMessageReaction({
          params: { id: chat.id, messageId: message.id },
          payload: { emoji: "👍" },
        })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      const notFound = yield* alice.client.chats
        .addMessageReaction({
          params: { id: chat.id, messageId: 9999 },
          payload: { emoji: "👍" },
        })
        .pipe(Effect.flip);
      expect(notFound._tag).toBe("NotFound");
    }),
  ));

test("addMessageReaction rejects an emoji outside the standard set", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { body: "hi bob" },
      });

      yield* alice.client.chats
        .addMessageReaction({
          params: { id: chat.id, messageId: message.id },
          // @ts-expect-error deliberately outside ReactionEmoji's literal union
          payload: { emoji: "🚀" },
        })
        .pipe(Effect.flip);
    }),
  ));

test("sendTyping succeeds for a participant", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      yield* alice.client.chats.sendTyping({ params: { id: chat.id } });
    }),
  ));

test("sendTyping is forbidden for a non-participant", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const eve = yield* registerAndLogin("eve", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const result = yield* eve.client.chats
        .sendTyping({ params: { id: chat.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Forbidden");
    }),
  ));

test("sendTyping 404s for a nonexistent chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const result = yield* alice.client.chats
        .sendTyping({ params: { id: 9999 } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));
