import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { eq } from "drizzle-orm";
import { Effect, Metric } from "effect";
import {
  ChatApi,
  MAX_GROUP_PARTICIPANTS,
  MAX_INVITES_PER_CHAT,
} from "./Api.ts";
import { Db } from "./Db.ts";
import { contentCreatedTotal } from "./Metrics.ts";
import { chatInvites, users } from "./db/schema.ts";
import { makeTestRun } from "./testApi.ts";

const run = makeTestRun();

const makeClient = HttpApiClient.make(ChatApi, { baseUrl: "http://localhost" });

const makeAuthedClient = (token: string) =>
  HttpApiClient.make(ChatApi, {
    baseUrl: "http://localhost",
    transformClient: (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
      ),
  });

const registerAndLogin = (username: string, password: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const user = yield* c.users.register({ payload: { username, password } });
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    return { user, accessToken, client: yield* makeAuthedClient(accessToken) };
  });

// Simulates promoting a user to admin out-of-band (there's no API for it —
// registration always creates a "user") and returns a freshly-authenticated
// client for them — role is baked into the JWT at sign time, so a promoted
// user must log in again to get a token reflecting it.
const promoteToAdmin = (username: string, password: string) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* Effect.tryPromise(() =>
      db
        .update(users)
        .set({ role: "admin" })
        .where(eq(users.username, username)),
    ).pipe(Effect.orDie);
    const c = yield* makeClient;
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    return yield* makeAuthedClient(accessToken);
  });

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

test("createGroupChat creates a chat with the creator plus given participants", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");

      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Trip planning",
          participantIds: [bob.user.id, carol.user.id],
        },
      });
      expect(chat.type).toBe("group");
      expect(chat.title).toBe("Trip planning");
      expect(chat.createdBy).toBe(alice.user.id);
      expect(chat.participants.map((p) => p.userId).sort()).toEqual(
        [alice.user.id, bob.user.id, carol.user.id].sort(),
      );
    }),
  ));

test("createGroupChat rejects duplicate participant ids", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const result = yield* alice.client.chats
        .createGroupChat({
          payload: {
            title: "Dup",
            participantIds: [bob.user.id, bob.user.id],
          },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
    }),
  ));

test("createGroupChat rejects including yourself in participantIds", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const result = yield* alice.client.chats
        .createGroupChat({
          payload: {
            title: "Self",
            participantIds: [bob.user.id, alice.user.id],
          },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
    }),
  ));

test("createGroupChat 404s when a participant doesn't exist", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const result = yield* alice.client.chats
        .createGroupChat({
          payload: { title: "Ghost", participantIds: [9999] },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("addParticipants lets the creator add people, up to the group cap", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");

      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const updated = yield* alice.client.chats.addParticipants({
        params: { id: chat.id },
        payload: { participantIds: [carol.user.id] },
      });
      expect(updated.participants.map((p) => p.userId).sort()).toEqual(
        [alice.user.id, bob.user.id, carol.user.id].sort(),
      );

      // Adding someone who's already in doesn't error and doesn't duplicate.
      const again = yield* alice.client.chats.addParticipants({
        params: { id: chat.id },
        payload: { participantIds: [carol.user.id] },
      });
      expect(again.participants).toHaveLength(3);
    }),
  ));

// Inserts bare user rows directly (bypassing register's argon2id hashing,
// which is far too slow to do MAX_GROUP_PARTICIPANTS times per test) — these
// users only need to exist as participant targets, never to authenticate.
const insertDummyUsers = (count: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    return yield* Effect.tryPromise(() =>
      db
        .insert(users)
        .values(
          Array.from({ length: count }, (_, i) => ({
            username: `dummy-${crypto.randomUUID()}-${i}`,
            passwordHash: "unused",
          })),
        )
        .returning({ id: users.id }),
    ).pipe(Effect.orDie);
  });

test("addParticipants is forbidden for non-creators and rejects exceeding the cap", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const forbidden = yield* bob.client.chats
        .addParticipants({
          params: { id: chat.id },
          payload: { participantIds: [alice.user.id] },
        })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      // Fill up remaining slots, then try to push one past the cap. Two
      // participants (alice, bob) are already in, so this is the max group
      // size minus 2 more, plus one over.
      const others = yield* insertDummyUsers(MAX_GROUP_PARTICIPANTS - 1);
      const toAdd = others
        .slice(0, MAX_GROUP_PARTICIPANTS - 2)
        .map((o) => o.id);
      yield* alice.client.chats.addParticipants({
        params: { id: chat.id },
        payload: { participantIds: toAdd },
      });
      const overCap = yield* alice.client.chats
        .addParticipants({
          params: { id: chat.id },
          payload: {
            participantIds: [others[MAX_GROUP_PARTICIPANTS - 2]!.id],
          },
        })
        .pipe(Effect.flip);
      expect(overCap._tag).toBe("InvalidChatRequest");
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
        payload: { contentType: "text", content: "hello bob" },
      });
      expect(message.senderId).toBe(alice.user.id);
      expect(message.content).toBe("hello bob");
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
          payload: { contentType: "text", content: "intruding" },
        })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");
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
          payload: { contentType: "text", content: "x".repeat(4001) },
        })
        .pipe(Effect.flip);
    }),
  ));

test("createMessage creates an image_url message from an allowlisted host", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: {
          contentType: "image_url",
          content: "https://picsum.photos/200",
        },
      });
      expect(message.contentType).toBe("image_url");
      expect(message.content).toBe("https://picsum.photos/200");
    }),
  ));

test("createMessage rejects an image_url from a non-allowlisted host", () =>
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
          payload: {
            contentType: "image_url",
            content: "https://evil.example.com/cat.png",
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("createMessage rejects a data: image_url", () =>
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
          payload: {
            contentType: "image_url",
            content: "data:image/png;base64,iVBORw0KGgo=",
          },
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
        payload: { contentType: "text", content: "what's for lunch?" },
      });
      expect(parent.parentMessage).toBeNull();

      const reply = yield* bob.client.chats.createMessage({
        params: { id: chat.id },
        payload: {
          contentType: "text",
          content: "tacos",
          parentMessageId: parent.id,
        },
      });
      expect(reply.parentMessage).not.toBeNull();
      expect(reply.parentMessage?.id).toBe(parent.id);
      expect(reply.parentMessage?.senderId).toBe(alice.user.id);
      expect(reply.parentMessage?.senderName).toBe("alice");
      expect(reply.parentMessage?.contentType).toBe("text");
      expect(reply.parentMessage?.content).toBe("what's for lunch?");

      // The preview round-trips through listMessages too, not just the
      // create response.
      const page = yield* bob.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      const listedReply = page.messages.find((m) => m.id === reply.id);
      expect(listedReply?.parentMessage?.id).toBe(parent.id);
      expect(listedReply?.parentMessage?.content).toBe("what's for lunch?");
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
        payload: { contentType: "text", content: longContent },
      });
      const reply = yield* bob.client.chats.createMessage({
        params: { id: chat.id },
        payload: {
          contentType: "text",
          content: "long one",
          parentMessageId: parent.id,
        },
      });
      // Only a preview-length snippet rides along, not the full body.
      expect(reply.parentMessage?.content.length).toBe(120);
      expect(reply.parentMessage?.content).toBe("x".repeat(120));
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
        payload: { contentType: "text", content: "hi carol" },
      });
      // …can't be quoted from the alice↔bob chat.
      const result = yield* alice.client.chats
        .createMessage({
          params: { id: chatAB.id },
          payload: {
            contentType: "text",
            content: "cross-chat reply",
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
            contentType: "text",
            content: "reply to nothing",
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
        payload: { contentType: "text", content: "delete me" },
      });
      const reply = yield* bob.client.chats.createMessage({
        params: { id: chat.id },
        payload: {
          contentType: "text",
          content: "still here",
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
        payload: { contentType: "text", content: "original question" },
      });
      const reply = yield* bob.client.chats.createMessage({
        params: { id: chat.id },
        payload: {
          contentType: "text",
          content: "first answer",
          parentMessageId: parent.id,
        },
      });

      const edited = yield* bob.client.chats.updateMessage({
        params: { id: chat.id, messageId: reply.id },
        payload: { contentType: "text", content: "revised answer" },
      });
      expect(edited.content).toBe("revised answer");
      expect(edited.parentMessage?.id).toBe(parent.id);
      expect(edited.parentMessage?.content).toBe("original question");
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
            payload: { contentType: "text", content: `msg ${i}` },
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
        payload: { contentType: "text", content: "hi" },
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

test("markRead marks messages up to a point as read and updates unreadCount + readByUserIds", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const m1 = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "one" },
      });
      const m2 = yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "two" },
      });
      yield* alice.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "three" },
      });

      const {
        chats: [bobChatBefore],
      } = yield* bob.client.chats.listChats({ query: {} });
      expect(bobChatBefore!.unreadCount).toBe(3);

      const afterRead = yield* bob.client.chats.markRead({
        params: { id: chat.id },
        payload: { messageId: m2.id },
      });
      expect(afterRead.unreadCount).toBe(1);

      const page = yield* alice.client.chats.listMessages({
        params: { id: chat.id },
        query: {},
      });
      const firstMessage = page.messages.find((m) => m.id === m1.id);
      expect(firstMessage?.readByUserIds).toEqual([bob.user.id]);
      const thirdMessage = page.messages.find(
        (m) => m.id !== m1.id && m.id !== m2.id,
      );
      expect(thirdMessage?.readByUserIds).toEqual([]);
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
        payload: { contentType: "text", content: "original" },
      });
      expect(message.updatedAt).toBe(message.createdAt);

      const edited = yield* alice.client.chats.updateMessage({
        params: { id: chat.id, messageId: message.id },
        payload: { contentType: "text", content: "edited" },
      });
      expect(edited.content).toBe("edited");
      expect(edited.updatedAt).toBeGreaterThanOrEqual(message.updatedAt);

      const forbidden = yield* bob.client.chats
        .updateMessage({
          params: { id: chat.id, messageId: message.id },
          payload: { contentType: "text", content: "hijacked" },
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
        payload: { contentType: "text", content: "hi bob" },
      });

      const result = yield* alice.client.chats
        .updateMessage({
          params: { id: chatAE.id, messageId: messageInAB.id },
          payload: { contentType: "text", content: "wrong chat" },
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
        payload: { contentType: "text", content: "delete me" },
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

// Finds one emoji's summary in a `reactions` array, or a zero/false default
// if that emoji has no reactions at all (mirrors the same helper in
// engagement.test.ts — see ReactionSummary in reactions.ts).
const reactionOf = (
  reactions: ReadonlyArray<{
    emoji: string;
    count: number;
    reactedByMe: boolean;
  }>,
  emoji: string,
) =>
  reactions.find((r) => r.emoji === emoji) ?? {
    emoji,
    count: 0,
    reactedByMe: false,
  };

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
        payload: { contentType: "text", content: "hi bob" },
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
        payload: { contentType: "text", content: "hi bob" },
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
        payload: { contentType: "text", content: "hi bob" },
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
        payload: { contentType: "text", content: "hi bob" },
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
        payload: { contentType: "text", content: "hi bob" },
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

test("addParticipants does not exceed the group cap when two requests race", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Race", participantIds: [bob.user.id] },
      });
      // 2 participants so far (alice, bob); cap is 20, so 18 slots remain.
      const pool = yield* insertDummyUsers(MAX_GROUP_PARTICIPANTS - 1);
      const fillsTheCap = pool.slice(0, MAX_GROUP_PARTICIPANTS - 2);
      const oneMore = pool[MAX_GROUP_PARTICIPANTS - 2]!;

      // One request fills every remaining slot exactly to the cap; the
      // other adds one further user. Run concurrently — combined, they'd
      // push the group to 21 members if the cap check weren't atomic with
      // the insert.
      const [fillResult, oneMoreResult] = yield* Effect.all(
        [
          alice.client.chats
            .addParticipants({
              params: { id: chat.id },
              payload: { participantIds: fillsTheCap.map((u) => u.id) },
            })
            .pipe(Effect.result),
          alice.client.chats
            .addParticipants({
              params: { id: chat.id },
              payload: { participantIds: [oneMore.id] },
            })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );

      const outcomes = [fillResult, oneMoreResult];
      const succeeded = outcomes.filter((r) => r._tag === "Success");
      const failed = outcomes.filter((r) => r._tag === "Failure");
      // Exactly one of the two racing requests must have been rejected —
      // both together would have exceeded the cap.
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(
        (failed[0] as unknown as { failure: { _tag: string } }).failure._tag,
      ).toBe("InvalidChatRequest");

      const finalChat = yield* alice.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(finalChat.participants.length).toBeLessThanOrEqual(
        MAX_GROUP_PARTICIPANTS,
      );
    }),
  ));

test("deleting a group chat's creator sets createdBy to null instead of deleting the chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Survives", participantIds: [bob.user.id] },
      });

      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db.delete(users).where(eq(users.id, alice.user.id)),
      ).pipe(Effect.orDie);

      const survived = yield* bob.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(survived.title).toBe("Survives");
      expect(survived.createdBy).toBeNull();
      expect(survived.participants.map((p) => p.userId)).toContain(bob.user.id);

      // With no creator left, renaming is now forbidden for everyone.
      const result = yield* bob.client.chats
        .updateChat({ params: { id: chat.id }, payload: { title: "Nope" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Forbidden");
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

test("createGroupChat's participant list is capped at the schema level", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const pool = yield* insertDummyUsers(MAX_GROUP_PARTICIPANTS);

      // Exactly at the limit (19 others + the creator = 20 total) succeeds.
      const atCap = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "At cap",
          participantIds: pool
            .slice(0, MAX_GROUP_PARTICIPANTS - 1)
            .map((u) => u.id),
        },
      });
      expect(atCap.participants).toHaveLength(MAX_GROUP_PARTICIPANTS);

      // One more than that is rejected by the payload schema itself
      // (Schema.maxItems on participantIds) before it ever reaches the
      // handler's own cap check.
      yield* alice.client.chats
        .createGroupChat({
          payload: {
            title: "Over cap",
            participantIds: pool
              .slice(0, MAX_GROUP_PARTICIPANTS)
              .map((u) => u.id),
          },
        })
        .pipe(Effect.flip);
    }),
  ));

test("addParticipants's participant list is capped at the schema level", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      const pool = yield* insertDummyUsers(MAX_GROUP_PARTICIPANTS);

      // A single addParticipants request can never legitimately add more
      // than MAX_GROUP_PARTICIPANTS - 1 people (the creator already takes
      // one slot) — this is rejected by the payload schema itself
      // (Schema.maxItems), before it ever reaches the handler's own cap
      // check.
      yield* alice.client.chats
        .addParticipants({
          params: { id: chat.id },
          payload: { participantIds: pool.map((u) => u.id) },
        })
        .pipe(Effect.flip);
    }),
  ));

test("addParticipants rejects adding people to a direct chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const result = yield* alice.client.chats
        .addParticipants({
          params: { id: chat.id },
          payload: { participantIds: [carol.user.id] },
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
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

test("markRead 404s for a missing chat or a message from a different chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");

      const chatAB = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const messageInAB = yield* alice.client.chats.createMessage({
        params: { id: chatAB.id },
        payload: { contentType: "text", content: "hi bob" },
      });

      const missingChat = yield* alice.client.chats
        .markRead({
          params: { id: 9999 },
          payload: { messageId: messageInAB.id },
        })
        .pipe(Effect.flip);
      expect(missingChat._tag).toBe("NotFound");

      const chatAC = yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const messageInAC = yield* alice.client.chats.createMessage({
        params: { id: chatAC.id },
        payload: { contentType: "text", content: "hi carol" },
      });

      // messageInAC exists, but not in chatAB.
      const wrongChat = yield* bob.client.chats
        .markRead({
          params: { id: chatAB.id },
          payload: { messageId: messageInAC.id },
        })
        .pipe(Effect.flip);
      expect(wrongChat._tag).toBe("NotFound");
    }),
  ));

test("leaveChat lets a non-creator leave, keeping the chat for the rest", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });

      yield* bob.client.chats.leaveChat({ params: { id: chat.id } });

      const survived = yield* alice.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(survived.participants.map((p) => p.userId).sort()).toEqual(
        [alice.user.id, carol.user.id].sort(),
      );
      expect(survived.createdBy).toBe(alice.user.id);

      // bob is no longer a participant, so the chat still exists but is now
      // forbidden to him.
      const afterLeave = yield* bob.client.chats
        .getChat({ params: { id: chat.id } })
        .pipe(Effect.flip);
      expect(afterLeave._tag).toBe("Forbidden");
    }),
  ));

test("leaveChat rejects leaving a direct chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const result = yield* alice.client.chats
        .leaveChat({ params: { id: chat.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
    }),
  ));

test("leaveChat transfers ownership to the longest-standing remaining participant when the creator leaves, and deletes the chat once empty", () =>
  run(
    Effect.gen(function* () {
      // bob and carol are added to the group in the same insert, so they
      // share a joinedAt — the tie-break (lowest userId) picks bob, since he
      // registered (and so got his id) before carol.
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });

      yield* alice.client.chats.leaveChat({ params: { id: chat.id } });

      const afterAliceLeft = yield* bob.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(afterAliceLeft.createdBy).toBe(bob.user.id);
      expect(afterAliceLeft.participants.map((p) => p.userId).sort()).toEqual(
        [bob.user.id, carol.user.id].sort(),
      );

      yield* carol.client.chats.leaveChat({ params: { id: chat.id } });
      yield* bob.client.chats.leaveChat({ params: { id: chat.id } });

      // Once the last participant leaves, the chat is deleted outright.
      const gone = yield* bob.client.chats
        .getChat({ params: { id: chat.id } })
        .pipe(Effect.flip);
      expect(gone._tag).toBe("NotFound");
    }),
  ));

test("removeParticipant lets the creator remove someone, and an admin who isn't a participant too", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });

      const updated = yield* alice.client.chats.removeParticipant({
        params: { id: chat.id, userId: bob.user.id },
      });
      expect(updated.participants.map((p) => p.userId).sort()).toEqual(
        [alice.user.id, carol.user.id].sort(),
      );

      // Non-creator, non-admin can't remove anyone.
      const forbidden = yield* carol.client.chats
        .removeParticipant({ params: { id: chat.id, userId: alice.user.id } })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      yield* registerAndLogin("dave", "pw-testpass");
      const adminClient = yield* promoteToAdmin("dave", "pw-testpass");
      const asAdmin = yield* adminClient.chats.removeParticipant({
        params: { id: chat.id, userId: carol.user.id },
      });
      expect(asAdmin.participants.map((p) => p.userId)).toEqual([
        alice.user.id,
      ]);
    }),
  ));

test("removeParticipant rejects removing yourself, a non-participant, or the chat's last participant", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const removeSelf = yield* alice.client.chats
        .removeParticipant({ params: { id: chat.id, userId: alice.user.id } })
        .pipe(Effect.flip);
      expect(removeSelf._tag).toBe("InvalidChatRequest");

      const removeStranger = yield* alice.client.chats
        .removeParticipant({ params: { id: chat.id, userId: carol.user.id } })
        .pipe(Effect.flip);
      expect(removeStranger._tag).toBe("NotFound");

      // Shrink the chat down to bob alone (ownership transfers to him),
      // then have an admin try to remove the last remaining participant.
      yield* alice.client.chats.leaveChat({ params: { id: chat.id } });
      yield* registerAndLogin("erin", "pw-testpass");
      const adminClient = yield* promoteToAdmin("erin", "pw-testpass");
      const removeLast = yield* adminClient.chats
        .removeParticipant({ params: { id: chat.id, userId: bob.user.id } })
        .pipe(Effect.flip);
      expect(removeLast._tag).toBe("InvalidChatRequest");
    }),
  ));

test("removeParticipant transfers ownership when the removed participant was the creator", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });

      yield* registerAndLogin("dave", "pw-testpass");
      const adminClient = yield* promoteToAdmin("dave", "pw-testpass");
      yield* adminClient.chats.removeParticipant({
        params: { id: chat.id, userId: alice.user.id },
      });

      const afterRemoval = yield* bob.client.chats.getChat({
        params: { id: chat.id },
      });
      expect(afterRemoval.createdBy).toBe(bob.user.id);
      expect(afterRemoval.participants.map((p) => p.userId).sort()).toEqual(
        [bob.user.id, carol.user.id].sort(),
      );
    }),
  ));

test("deleteChat lets the creator (or an admin) delete a group chat outright", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");

      const directChat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const directResult = yield* alice.client.chats
        .deleteChat({ params: { id: directChat.id } })
        .pipe(Effect.flip);
      expect(directResult._tag).toBe("InvalidChatRequest");

      const groupChat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      const forbidden = yield* bob.client.chats
        .deleteChat({ params: { id: groupChat.id } })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      yield* alice.client.chats.deleteChat({ params: { id: groupChat.id } });

      const gone = yield* bob.client.chats
        .getChat({ params: { id: groupChat.id } })
        .pipe(Effect.flip);
      expect(gone._tag).toBe("NotFound");
    }),
  ));

test("transferOwnership lets the creator hand off ownership, and 404s for a non-participant target", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const missingTarget = yield* alice.client.chats
        .transferOwnership({
          params: { id: chat.id },
          payload: { userId: carol.user.id },
        })
        .pipe(Effect.flip);
      expect(missingTarget._tag).toBe("NotFound");

      const updated = yield* alice.client.chats.transferOwnership({
        params: { id: chat.id },
        payload: { userId: bob.user.id },
      });
      expect(updated.createdBy).toBe(bob.user.id);

      // Ownership moved — alice can no longer rename, bob now can.
      const renameByAlice = yield* alice.client.chats
        .updateChat({ params: { id: chat.id }, payload: { title: "Nope" } })
        .pipe(Effect.flip);
      expect(renameByAlice._tag).toBe("Forbidden");
      const renamed = yield* bob.client.chats.updateChat({
        params: { id: chat.id },
        payload: { title: "Renamed by bob" },
      });
      expect(renamed.title).toBe("Renamed by bob");
    }),
  ));

test("transferOwnership: once a chat is ownerless, any participant can claim it, but a non-participant still can't", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const dave = yield* registerAndLogin("dave", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      // While alice still owns it, bob (a mere participant) can't transfer
      // ownership.
      const forbidden = yield* bob.client.chats
        .transferOwnership({
          params: { id: chat.id },
          payload: { userId: bob.user.id },
        })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      // Simulate alice's account being deleted — createdBy goes to null
      // (see db/schema.ts), leaving the group ownerless.
      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db.delete(users).where(eq(users.id, alice.user.id)),
      ).pipe(Effect.orDie);

      // dave isn't a participant, so he still can't claim it.
      const notParticipant = yield* dave.client.chats
        .transferOwnership({
          params: { id: chat.id },
          payload: { userId: bob.user.id },
        })
        .pipe(Effect.flip);
      expect(notParticipant._tag).toBe("Forbidden");

      // But bob, a participant of the now-ownerless chat, can claim it.
      const claimed = yield* bob.client.chats.transferOwnership({
        params: { id: chat.id },
        payload: { userId: bob.user.id },
      });
      expect(claimed.createdBy).toBe(bob.user.id);
    }),
  ));

// --- Per-chat roles (issue #220) ---

test("group chat creation seeds the creator as owner and everyone else as member", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const byUserId = new Map(chat.participants.map((p) => [p.userId, p]));
      expect(byUserId.get(alice.user.id)?.role).toBe("owner");
      expect(byUserId.get(bob.user.id)?.role).toBe("member");
    }),
  ));

test("direct chat participants are always plain members", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      for (const p of chat.participants) expect(p.role).toBe("member");
    }),
  ));

test("updateParticipantRole: only the owner can promote/demote, and not the owner themselves", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });

      // A plain member can't promote anyone, including themselves.
      const memberAttempt = yield* bob.client.chats
        .updateParticipantRole({
          params: { id: chat.id, userId: bob.user.id },
          payload: { role: "admin" },
        })
        .pipe(Effect.flip);
      expect(memberAttempt._tag).toBe("Forbidden");

      // The owner promotes bob to admin.
      const promoted = yield* alice.client.chats.updateParticipantRole({
        params: { id: chat.id, userId: bob.user.id },
        payload: { role: "admin" },
      });
      expect(
        promoted.participants.find((p) => p.userId === bob.user.id)?.role,
      ).toBe("admin");

      // An admin still can't promote/demote anyone else — only the owner can.
      const adminAttempt = yield* bob.client.chats
        .updateParticipantRole({
          params: { id: chat.id, userId: carol.user.id },
          payload: { role: "admin" },
        })
        .pipe(Effect.flip);
      expect(adminAttempt._tag).toBe("Forbidden");

      // The owner's own role can't be changed through this endpoint.
      const targetOwner = yield* alice.client.chats
        .updateParticipantRole({
          params: { id: chat.id, userId: alice.user.id },
          payload: { role: "member" },
        })
        .pipe(Effect.flip);
      expect(targetOwner._tag).toBe("InvalidChatRequest");

      // The owner demotes bob back to member.
      const demoted = yield* alice.client.chats.updateParticipantRole({
        params: { id: chat.id, userId: bob.user.id },
        payload: { role: "member" },
      });
      expect(
        demoted.participants.find((p) => p.userId === bob.user.id)?.role,
      ).toBe("member");
    }),
  ));

test("admins (not just the owner) can rename, add/remove participants, and delete any message", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const dave = yield* registerAndLogin("dave", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: {
          title: "Group",
          participantIds: [bob.user.id, carol.user.id],
        },
      });
      yield* alice.client.chats.updateParticipantRole({
        params: { id: chat.id, userId: bob.user.id },
        payload: { role: "admin" },
      });

      const renamed = yield* bob.client.chats.updateChat({
        params: { id: chat.id },
        payload: { title: "Renamed by admin" },
      });
      expect(renamed.title).toBe("Renamed by admin");

      const added = yield* bob.client.chats.addParticipants({
        params: { id: chat.id },
        payload: { participantIds: [dave.user.id] },
      });
      expect(added.participants.map((p) => p.userId)).toContain(dave.user.id);

      const message = yield* carol.client.chats.createMessage({
        params: { id: chat.id },
        payload: { contentType: "text", content: "hi all" },
      });
      // A plain member can't delete someone else's message...
      const memberDelete = yield* dave.client.chats
        .deleteMessage({ params: { id: chat.id, messageId: message.id } })
        .pipe(Effect.flip);
      expect(memberDelete._tag).toBe("Forbidden");
      // ...but the chat's admin can.
      yield* bob.client.chats.deleteMessage({
        params: { id: chat.id, messageId: message.id },
      });

      const removed = yield* bob.client.chats.removeParticipant({
        params: { id: chat.id, userId: dave.user.id },
      });
      expect(removed.participants.map((p) => p.userId)).not.toContain(
        dave.user.id,
      );
    }),
  ));

test("removeParticipant refuses to let a chat-level admin remove the owner", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      yield* alice.client.chats.updateParticipantRole({
        params: { id: chat.id, userId: bob.user.id },
        payload: { role: "admin" },
      });

      const result = yield* bob.client.chats
        .removeParticipant({ params: { id: chat.id, userId: alice.user.id } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("Forbidden");
    }),
  ));

// --- Invite links (issue #220) ---

test("createChatInvite is owner/admin only, and joinChatViaInvite adds the redeemer as a member", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const forbidden = yield* bob.client.chats
        .createChatInvite({ params: { id: chat.id }, payload: {} })
        .pipe(Effect.flip);
      expect(forbidden._tag).toBe("Forbidden");

      const invite = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: {},
      });
      expect(invite.chatId).toBe(chat.id);
      expect(invite.useCount).toBe(0);
      expect(invite.revokedAt).toBeNull();

      const joined = yield* carol.client.chats.joinChatViaInvite({
        params: { code: invite.code },
      });
      expect(joined.id).toBe(chat.id);
      const carolParticipant = joined.participants.find(
        (p) => p.userId === carol.user.id,
      );
      expect(carolParticipant?.role).toBe("member");

      const invites = yield* alice.client.chats.listChatInvites({
        params: { id: chat.id },
      });
      expect(invites.find((i) => i.id === invite.id)?.useCount).toBe(1);

      // Joining again with a code you're already in via is a no-op, not an
      // error, and doesn't bump useCount further.
      const rejoined = yield* carol.client.chats.joinChatViaInvite({
        params: { code: invite.code },
      });
      expect(rejoined.id).toBe(chat.id);
      const invitesAfterRejoin = yield* alice.client.chats.listChatInvites({
        params: { id: chat.id },
      });
      expect(invitesAfterRejoin.find((i) => i.id === invite.id)?.useCount).toBe(
        1,
      );
    }),
  ));

test("joinChatViaInvite 404s for an unknown code", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const result = yield* alice.client.chats
        .joinChatViaInvite({ params: { code: "does-not-exist" } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("NotFound");
    }),
  ));

test("revokeChatInvite invalidates the code for future joins", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      const invite = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: {},
      });

      yield* alice.client.chats.revokeChatInvite({
        params: { id: chat.id, inviteId: invite.id },
      });

      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const result = yield* carol.client.chats
        .joinChatViaInvite({ params: { code: invite.code } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");

      const doubleRevoke = yield* alice.client.chats
        .revokeChatInvite({ params: { id: chat.id, inviteId: invite.id } })
        .pipe(Effect.flip);
      expect(doubleRevoke._tag).toBe("NotFound");
    }),
  ));

test("joinChatViaInvite enforces expiry and maxUses", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const dave = yield* registerAndLogin("dave", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      // maxUses: 1 — the first join succeeds, the second is rejected.
      const singleUse = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: { maxUses: 1 },
      });
      yield* carol.client.chats.joinChatViaInvite({
        params: { code: singleUse.code },
      });
      const overUse = yield* dave.client.chats
        .joinChatViaInvite({ params: { code: singleUse.code } })
        .pipe(Effect.flip);
      expect(overUse._tag).toBe("InvalidChatRequest");

      // An already-expired invite (simulated by backdating it directly,
      // since expiresInHours can't express "already in the past") is
      // rejected too.
      const expiring = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: { expiresInHours: 1 },
      });
      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db
          .update(chatInvites)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(eq(chatInvites.id, expiring.id)),
      ).pipe(Effect.orDie);
      const expired = yield* dave.client.chats
        .joinChatViaInvite({ params: { code: expiring.code } })
        .pipe(Effect.flip);
      expect(expired._tag).toBe("InvalidChatRequest");
    }),
  ));

test("joinChatViaInvite rejects joining once the group is at its participant cap", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const others = yield* insertDummyUsers(MAX_GROUP_PARTICIPANTS - 1);
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [others[0]!.id] },
      });
      yield* alice.client.chats.addParticipants({
        params: { id: chat.id },
        payload: { participantIds: others.slice(1).map((o) => o.id) },
      });

      const invite = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: {},
      });
      const outsider = yield* registerAndLogin("outsider", "pw-testpass");
      const result = yield* outsider.client.chats
        .joinChatViaInvite({ params: { code: invite.code } })
        .pipe(Effect.flip);
      expect(result._tag).toBe("InvalidChatRequest");
    }),
  ));

// Regression test for a TOCTOU race between the pre-transaction `useCount`
// read and the increment: two concurrent redemptions of a `maxUses: 1`
// invite must not both succeed (see the guarded `WHERE useCount < maxUses`
// update in `joinChatViaInvite`, ChatsHandler.ts).
test("joinChatViaInvite serializes concurrent redemptions against maxUses", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const carol = yield* registerAndLogin("carol", "pw-testpass");
      const dave = yield* registerAndLogin("dave", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      const invite = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: { maxUses: 1 },
      });

      const [carolResult, daveResult] = yield* Effect.all(
        [
          carol.client.chats
            .joinChatViaInvite({ params: { code: invite.code } })
            .pipe(Effect.result),
          dave.client.chats
            .joinChatViaInvite({ params: { code: invite.code } })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      const results = [carolResult, daveResult];
      const succeeded = results.filter((r) => r._tag === "Success");
      const failed = results.filter((r) => r._tag === "Failure");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      if (failed[0]?._tag === "Failure") {
        expect((failed[0].failure as { _tag: string })._tag).toBe(
          "InvalidChatRequest",
        );
      }

      const invites = yield* alice.client.chats.listChatInvites({
        params: { id: chat.id },
      });
      expect(invites.find((i) => i.id === invite.id)?.useCount).toBe(1);
    }),
  ));

test("createChatInvite doesn't count revoked/expired invites toward the per-chat cap", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw-testpass");
      const bob = yield* registerAndLogin("bob", "pw-testpass");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const invites = [];
      for (let i = 0; i < MAX_INVITES_PER_CHAT; i++) {
        invites.push(
          yield* alice.client.chats.createChatInvite({
            params: { id: chat.id },
            payload: {},
          }),
        );
      }

      const atCap = yield* alice.client.chats
        .createChatInvite({ params: { id: chat.id }, payload: {} })
        .pipe(Effect.flip);
      expect(atCap._tag).toBe("InvalidChatRequest");

      // Revoking one frees a slot even though the row itself still exists.
      yield* alice.client.chats.revokeChatInvite({
        params: { id: chat.id, inviteId: invites[0]!.id },
      });
      const afterRevoke = yield* alice.client.chats.createChatInvite({
        params: { id: chat.id },
        payload: {},
      });
      expect(afterRevoke.chatId).toBe(chat.id);
    }),
  ));
