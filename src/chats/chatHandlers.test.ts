import { expect, test } from "bun:test";
import { Effect } from "effect";
import { DEFAULT_CHATS_LIMIT } from "../Api.ts";
import { makeTestRun } from "../testApi.ts";
import {
  buryUnreadDirectChat,
  insertDummyUsers,
  makeClient,
  registerAndLogin,
} from "./testKit.ts";

const run = makeTestRun();

test("createDirectChat creates a chat between two users", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");

      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      expect(chat.type).toBe("direct");
      expect(chat.title).toBeNull();
      expect(chat.unreadCount).toBe(0);
      expect(chat.lastMessage).toBeNull();
      expect(chat.participants.map((p) => p.userId).sort()).toEqual(
        [alice.user.id, bob.user.id].sort(),
      );
    }),
  ));

test("createDirectChat is idempotent regardless of who initiates", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");

      const first = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const second = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const third = yield* bob.client.chats.createDirectChat({
        payload: { userId: alice.user.id },
      });

      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
    }),
  ));

test("createDirectChat rejects chatting with yourself", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const result = yield* alice.client.chats
        .createDirectChat({ payload: { userId: alice.user.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
    }),
  ));

test("createDirectChat 404s for a nonexistent user", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const result = yield* alice.client.chats
        .createDirectChat({ payload: { userId: 9999 } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("listChats only returns chats the current user participates in, newest activity first", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");

      const chatWithBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const chatWithCarol = yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      // Bumps chatWithBob's updatedAt so it should sort to the top.
      yield* alice.client.chats.createMessage({
        params: { id: chatWithBob.id },
        payload: { contentType: "text", content: "hi bob" },
      });

      const aliceChats = yield* alice.client.chats.listChats({
        query: {},
      });
      expect(aliceChats.chats.map((c) => c.id)).toEqual([
        chatWithBob.id,
        chatWithCarol.id,
      ]);

      const bobChats = yield* bob.client.chats.listChats({ query: {} });
      expect(bobChats.chats.map((c) => c.id)).toEqual([chatWithBob.id]);

      const daveResult = yield* registerAndLogin("dave", "pw-testpass");
      const daveChats = yield* daveResult.client.chats.listChats({
        query: {},
      });
      expect(daveChats.chats).toHaveLength(0);
    }),
  ));

test("listChats paginates newest-first with a keyset cursor, without gaps or duplicates", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      // Direct DB inserts (bypassing register, same as
      // `insertDummyUsers`'s own rationale below) — this test just needs 5
      // other users to start direct chats with, not accounts that can log
      // in, and creating 5 more via `register` would trip
      // `REGISTER_MAX_ATTEMPTS_PER_IP` alongside `alice`'s own registration.
      const friends = yield* insertDummyUsers(5);

      const created: number[] = [];
      for (const friend of friends) {
        const chat = yield* alice.client.chats.createDirectChat({
          payload: { userId: friend.id },
        });
        created.push(chat.id);
      }
      // Newest activity sorts first; ties on `updatedAt` (plausible here,
      // since these are all created back-to-back) are broken by id desc.
      const expectedOrder = [...created].reverse();

      const firstPage = yield* alice.client.chats.listChats({
        query: { limit: 2 },
      });
      expect(firstPage.chats.map((c) => c.id)).toEqual(
        expectedOrder.slice(0, 2),
      );
      expect(firstPage.limit).toBe(2);
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = yield* alice.client.chats.listChats({
        query: { limit: 2, cursor: firstPage.nextCursor! },
      });
      expect(secondPage.chats.map((c) => c.id)).toEqual(
        expectedOrder.slice(2, 4),
      );
      expect(secondPage.nextCursor).not.toBeNull();

      const thirdPage = yield* alice.client.chats.listChats({
        query: { limit: 2, cursor: secondPage.nextCursor! },
      });
      expect(thirdPage.chats.map((c) => c.id)).toEqual(
        expectedOrder.slice(4, 5),
      );
      expect(thirdPage.nextCursor).toBeNull();
    }),
  ));

test("listChats rejects a malformed cursor", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const result = yield* alice.client.chats
        .listChats({ query: { cursor: "not-a-real-cursor" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
    }),
  ));

test("listChats rejects a limit above the max", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      yield* alice.client.chats
        .listChats({ query: { limit: 101 } })
        .pipe(Effect.flip);
    }),
  ));

test("updateChat lets the creator rename a group chat, but not others", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Old title", participantIds: [bob.user.id] },
      });

      const renamed = yield* alice.client.chats.updateChat({
        params: { id: chat.id },
        payload: { title: "New title" },
      });
      expect(renamed.title).toBe("New title");

      const forbidden = yield* bob.client.chats
        .updateChat({ params: { id: chat.id }, payload: { title: "Hijacked" } })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");
    }),
  ));

test("updateChat rejects renaming a direct chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const result = yield* alice.client.chats
        .updateChat({ params: { id: chat.id }, payload: { title: "Nope" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
    }),
  ));

test("listChats pairs each chat with its own newest message", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const withBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const withCarol = yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      // Interleaved, so no chat's id lines up with its last message's id.
      for (const [chat, content] of [
        [withCarol, "carol 1"],
        [withBob, "bob 1"],
        [withCarol, "carol 2"],
        [withBob, "bob 2"],
        [withBob, "bob 3"],
      ] as const)
        yield* alice.client.chats.createMessage({
          params: { id: chat.id },
          payload: { contentType: "text", content },
        });

      const { chats: listed } = yield* alice.client.chats.listChats({
        query: {},
      });
      const lastContent = new Map(
        listed.map((c) => [c.id, c.lastMessage?.content]),
      );
      expect(lastContent.get(withBob.id)).toBe("bob 3");
      expect(lastContent.get(withCarol.id)).toBe("carol 2");
    }),
  ));

// `version` (see db/schema.ts) is what lets a client detect deterministically
// that it missed a `chat_updated` event (issue #55) instead of just
// refetching blind whenever the next one happens to arrive — this pins the
// exact set of mutations that bump it, and the one case (marking your own
// message as read is a no-op) that must not.
test("chat version increments on every participant-visible mutation, and only then", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      // Not strangers to Alice, so the group is no message request for
      // either — accepting one would bump the version too.
      for (const friend of [bob, carol])
        yield* alice.client.chats.createDirectChat({
          payload: { userId: friend.user.id },
        });

      const created = yield* alice.client.chats.createGroupChat({
        payload: { title: "Trip planning", participantIds: [bob.user.id] },
      });
      expect(created.version).toBe(1);

      const renamed = yield* alice.client.chats.updateChat({
        params: { id: created.id },
        payload: { title: "Trip planning v2" },
      });
      expect(renamed.version).toBe(2);

      const withCarol = yield* alice.client.chats.addParticipants({
        params: { id: created.id },
        payload: { participantIds: [carol.user.id] },
      });
      expect(withCarol.version).toBe(3);

      const message = yield* alice.client.chats.createMessage({
        params: { id: created.id },
        payload: { contentType: "text", content: "hi" },
      });
      expect(
        (yield* alice.client.chats.getChat({ params: { id: created.id } }))
          .version,
      ).toBe(4);

      // Marking your own message as read touches nothing (only messages from
      // *other* senders count toward the mark-read query) — no event, no
      // version bump.
      const noOp = yield* alice.client.chats.markRead({
        params: { id: created.id },
        payload: { messageId: message.id },
      });
      expect(noOp.version).toBe(4);

      // Bob marking Alice's message as read is a real transition.
      const afterRead = yield* bob.client.chats.markRead({
        params: { id: created.id },
        payload: { messageId: message.id },
      });
      expect(afterRead.version).toBe(5);

      yield* alice.client.chats.updateMessage({
        params: { id: created.id, messageId: message.id },
        payload: { contentType: "text", content: "hi edited" },
      });
      expect(
        (yield* alice.client.chats.getChat({ params: { id: created.id } }))
          .version,
      ).toBe(6);

      yield* alice.client.chats.deleteMessage({
        params: { id: created.id, messageId: message.id },
      });
      expect(
        (yield* alice.client.chats.getChat({ params: { id: created.id } }))
          .version,
      ).toBe(7);
    }),
  ));

test("getChat 404s for a missing chat and is forbidden for non-participants", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const eve = yield* registerAndLogin("eve", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const missing = yield* alice.client.chats
        .getChat({ params: { id: 9999 } })
        .pipe(Effect.flip);
      expect(missing._tag).toBe("NotFound");

      const forbidden = yield* eve.client.chats
        .getChat({ params: { id: chat.id } })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");
    }),
  ));

test("createDirectChat does not create duplicate chats when two requests race", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");

      // Both requests see no existing chat and try to create one
      // concurrently — without the fix, this would leave two separate
      // direct chats for the same pair.
      const [first, second] = yield* Effect.all(
        [
          alice.client.chats.createDirectChat({
            payload: { userId: bob.user.id },
          }),
          bob.client.chats.createDirectChat({
            payload: { userId: alice.user.id },
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(second.id).toBe(first.id);

      const aliceChats = yield* alice.client.chats.listChats({ query: {} });
      expect(aliceChats.chats).toHaveLength(1);
    }),
  ));

test("every chats endpoint rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;

      const results = yield* Effect.all(
        [
          c.chats.listChats({ query: {} }).pipe(Effect.result),
          c.chats.getChat({ params: { id: 1 } }).pipe(Effect.result),
          c.chats
            .createDirectChat({ payload: { userId: 1 } })
            .pipe(Effect.result),
          c.chats
            .createGroupChat({
              payload: { title: "x", participantIds: [1] },
            })
            .pipe(Effect.result),
          c.chats
            .updateChat({ params: { id: 1 }, payload: { title: "x" } })
            .pipe(Effect.result),
          c.chats
            .addParticipants({
              params: { id: 1 },
              payload: { participantIds: [1] },
            })
            .pipe(Effect.result),
          c.chats
            .listMessages({ params: { id: 1 }, query: {} })
            .pipe(Effect.result),
          c.chats
            .createMessage({
              params: { id: 1 },
              payload: { contentType: "text", content: "hi" },
            })
            .pipe(Effect.result),
          c.chats.sendTyping({ params: { id: 1 } }).pipe(Effect.result),
          c.chats
            .markRead({ params: { id: 1 }, payload: { messageId: 1 } })
            .pipe(Effect.result),
          c.chats
            .updateMessage({
              params: { id: 1, messageId: 1 },
              payload: { contentType: "text", content: "hi" },
            })
            .pipe(Effect.result),
          c.chats
            .deleteMessage({ params: { id: 1, messageId: 1 } })
            .pipe(Effect.result),
          c.chats
            .removeParticipant({ params: { id: 1, userId: 1 } })
            .pipe(Effect.result),
          c.chats.leaveChat({ params: { id: 1 } }).pipe(Effect.result),
          c.chats.deleteChat({ params: { id: 1 } }).pipe(Effect.result),
          c.chats
            .transferOwnership({ params: { id: 1 }, payload: { userId: 1 } })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );

      for (const result of results) {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect((result.failure as { _tag: string })._tag).toBe(
            "Unauthorized",
          );
        }
      }
    }),
  ));

test("listChats with unread=true returns only unread chats, including ones past the first page", () =>
  run(
    Effect.gen(function* () {
      const { alice, dm } = yield* buryUnreadDirectChat;

      const unread = yield* alice.client.chats.listChats({
        query: { unread: "true" },
      });
      expect(unread.chats.map((c) => c.id)).toEqual([dm.id]);
      expect(unread.chats[0]!.unreadCount).toBe(3);
      expect(unread.nextCursor).toBeNull();

      // `unread=false` is the full list, same as omitting it.
      const all = yield* alice.client.chats.listChats({
        query: { unread: "false" },
      });
      expect(all.chats).toHaveLength(DEFAULT_CHATS_LIMIT);
      expect(all.nextCursor).not.toBeNull();
    }),
  ));

test("listChats with unread=true pages with the same cursor as the full list", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      // Already talking, so Bob's groups aren't message requests (#785).
      yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const unreadIds: number[] = [];
      for (let i = 0; i < 5; i++) {
        const group = yield* bob.client.chats.createGroupChat({
          payload: { title: `Group ${i}`, participantIds: [alice.user.id] },
        });
        const message = yield* bob.client.chats.createMessage({
          params: { id: group.id },
          payload: { contentType: "text", content: `hello ${i}` },
        });
        // Every other chat is read, so the unread ones are interleaved.
        if (i % 2 === 0) unreadIds.unshift(group.id);
        else
          yield* alice.client.chats.markRead({
            params: { id: group.id },
            payload: { messageId: message.id },
          });
      }

      const first = yield* alice.client.chats.listChats({
        query: { unread: "true", limit: 2 },
      });
      expect(first.nextCursor).not.toBeNull();
      const second = yield* alice.client.chats.listChats({
        query: { unread: "true", limit: 2, cursor: first.nextCursor! },
      });
      expect(second.nextCursor).toBeNull();
      expect([...first.chats, ...second.chats].map((c) => c.id)).toEqual(
        unreadIds,
      );
    }),
  ));
