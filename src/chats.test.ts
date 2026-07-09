import { expect, test } from "bun:test";
import {
  FetchHttpClient,
  HttpApiBuilder,
  HttpApiClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { ChatApi, MAX_GROUP_PARTICIPANTS } from "./Api.ts";
import { AuthenticationLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { Db } from "./Db.ts";
import { JwtLive } from "./Jwt.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { InMemoryPresenceStoreLive } from "./Presence.ts";
import { InMemoryPubSubLive } from "./PubSub.ts";
import { InMemoryRateLimiterLive } from "./RateLimiter.ts";
import { RealtimeConnectionsLive } from "./Realtime.ts";
import { RealtimeHandlerLive } from "./RealtimeHandler.ts";
import { makeTestDbAccessor, resetTestDb } from "./testDb.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import { VersionHandlerLive } from "./VersionHandler.ts";
import { users } from "./db/schema.ts";
import { InMemoryWsTicketLive } from "./WsTicket.ts";

// JwtLive reads JWT_SECRET from config; provide a deterministic test secret.
process.env.JWT_SECRET ??= "test-secret";

const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(PostsHandlerLive),
  Layer.provide(ChatsHandlerLive),
  Layer.provide(VersionHandlerLive),
  Layer.provide(RealtimeHandlerLive),
  Layer.provide(RealtimeConnectionsLive),
  Layer.provide(InMemoryPubSubLive),
  Layer.provide(InMemoryPresenceStoreLive),
  Layer.provide(InMemoryRateLimiterLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(JwtLive),
  Layer.provide(InMemoryWsTicketLive),
);

const { getTestDb } = makeTestDbAccessor();

const run = async <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | Db>,
): Promise<A> => {
  const db = await getTestDb();
  await resetTestDb(db);
  const TestDbLive = Layer.succeed(Db, db);

  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(
      ApiLive.pipe(Layer.provide(TestDbLive)),
      BunHttpServer.layerContext,
    ),
  );

  const mockFetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> =>
    handler(
      input instanceof Request ? input : new Request(input.toString(), init),
    );

  const TestClientLayer = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, mockFetch as typeof fetch),
    ),
  );

  try {
    return await Effect.runPromise(
      effect.pipe(Effect.provide(TestClientLayer), Effect.provide(TestDbLive)),
    );
  } finally {
    await dispose();
  }
};

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

test("createDirectChat creates a chat between two users", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");

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
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");

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
      const alice = yield* registerAndLogin("alice", "pw");
      const result = yield* alice.client.chats
        .createDirectChat({ payload: { userId: alice.user.id } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidChatRequest",
        );
      }
    }),
  ));

test("createDirectChat 404s for a nonexistent user", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const result = yield* alice.client.chats
        .createDirectChat({ payload: { userId: 9999 } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
      }
    }),
  ));

test("listChats only returns chats the current user participates in, newest activity first", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const carol = yield* registerAndLogin("carol", "pw");

      const chatWithBob = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const chatWithCarol = yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      // Bumps chatWithBob's updatedAt so it should sort to the top.
      yield* alice.client.chats.createMessage({
        path: { id: chatWithBob.id },
        payload: { contentType: "text", content: "hi bob" },
      });

      const aliceChats = yield* alice.client.chats.listChats({
        urlParams: {},
      });
      expect(aliceChats.chats.map((c) => c.id)).toEqual([
        chatWithBob.id,
        chatWithCarol.id,
      ]);

      const bobChats = yield* bob.client.chats.listChats({ urlParams: {} });
      expect(bobChats.chats.map((c) => c.id)).toEqual([chatWithBob.id]);

      const daveResult = yield* registerAndLogin("dave", "pw");
      const daveChats = yield* daveResult.client.chats.listChats({
        urlParams: {},
      });
      expect(daveChats.chats).toHaveLength(0);
    }),
  ));

test("listChats paginates newest-first with a keyset cursor, without gaps or duplicates", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
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
        urlParams: { limit: 2 },
      });
      expect(firstPage.chats.map((c) => c.id)).toEqual(
        expectedOrder.slice(0, 2),
      );
      expect(firstPage.limit).toBe(2);
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = yield* alice.client.chats.listChats({
        urlParams: { limit: 2, cursor: firstPage.nextCursor! },
      });
      expect(secondPage.chats.map((c) => c.id)).toEqual(
        expectedOrder.slice(2, 4),
      );
      expect(secondPage.nextCursor).not.toBeNull();

      const thirdPage = yield* alice.client.chats.listChats({
        urlParams: { limit: 2, cursor: secondPage.nextCursor! },
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
      const alice = yield* registerAndLogin("alice", "pw");
      const result = yield* alice.client.chats
        .listChats({ urlParams: { cursor: "not-a-real-cursor" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidChatRequest",
        );
      }
    }),
  ));

test("listChats rejects a limit above the max", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const result = yield* alice.client.chats
        .listChats({ urlParams: { limit: 101 } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("createGroupChat creates a chat with the creator plus given participants", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const carol = yield* registerAndLogin("carol", "pw");

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
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const result = yield* alice.client.chats
        .createGroupChat({
          payload: {
            title: "Dup",
            participantIds: [bob.user.id, bob.user.id],
          },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidChatRequest",
        );
      }
    }),
  ));

test("createGroupChat rejects including yourself in participantIds", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const result = yield* alice.client.chats
        .createGroupChat({
          payload: {
            title: "Self",
            participantIds: [bob.user.id, alice.user.id],
          },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidChatRequest",
        );
      }
    }),
  ));

test("createGroupChat 404s when a participant doesn't exist", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const result = yield* alice.client.chats
        .createGroupChat({
          payload: { title: "Ghost", participantIds: [9999] },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
      }
    }),
  ));

test("addParticipants lets the creator add people, up to the group cap", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const carol = yield* registerAndLogin("carol", "pw");

      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const updated = yield* alice.client.chats.addParticipants({
        path: { id: chat.id },
        payload: { participantIds: [carol.user.id] },
      });
      expect(updated.participants.map((p) => p.userId).sort()).toEqual(
        [alice.user.id, bob.user.id, carol.user.id].sort(),
      );

      // Adding someone who's already in doesn't error and doesn't duplicate.
      const again = yield* alice.client.chats.addParticipants({
        path: { id: chat.id },
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
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });

      const forbidden = yield* bob.client.chats
        .addParticipants({
          path: { id: chat.id },
          payload: { participantIds: [alice.user.id] },
        })
        .pipe(Effect.either);
      expect(forbidden._tag).toBe("Left");
      if (forbidden._tag === "Left") {
        expect((forbidden.left as { _tag: string })._tag).toBe("Forbidden");
      }

      // Fill up remaining slots, then try to push one past the cap. Two
      // participants (alice, bob) are already in, so this is the max group
      // size minus 2 more, plus one over.
      const others = yield* insertDummyUsers(MAX_GROUP_PARTICIPANTS - 1);
      const toAdd = others
        .slice(0, MAX_GROUP_PARTICIPANTS - 2)
        .map((o) => o.id);
      yield* alice.client.chats.addParticipants({
        path: { id: chat.id },
        payload: { participantIds: toAdd },
      });
      const overCap = yield* alice.client.chats
        .addParticipants({
          path: { id: chat.id },
          payload: {
            participantIds: [others[MAX_GROUP_PARTICIPANTS - 2]!.id],
          },
        })
        .pipe(Effect.either);
      expect(overCap._tag).toBe("Left");
      if (overCap._tag === "Left") {
        expect((overCap.left as { _tag: string })._tag).toBe(
          "InvalidChatRequest",
        );
      }
    }),
  ));

test("updateChat lets the creator rename a group chat, but not others", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Old title", participantIds: [bob.user.id] },
      });

      const renamed = yield* alice.client.chats.updateChat({
        path: { id: chat.id },
        payload: { title: "New title" },
      });
      expect(renamed.title).toBe("New title");

      const forbidden = yield* bob.client.chats
        .updateChat({ path: { id: chat.id }, payload: { title: "Hijacked" } })
        .pipe(Effect.either);
      expect(forbidden._tag).toBe("Left");
      if (forbidden._tag === "Left") {
        expect((forbidden.left as { _tag: string })._tag).toBe("Forbidden");
      }
    }),
  ));

test("updateChat rejects renaming a direct chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const result = yield* alice.client.chats
        .updateChat({ path: { id: chat.id }, payload: { title: "Nope" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidChatRequest",
        );
      }
    }),
  ));

test("createMessage sends a message, bumps chat activity, and is forbidden for non-participants", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const eve = yield* registerAndLogin("eve", "pw");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const message = yield* alice.client.chats.createMessage({
        path: { id: chat.id },
        payload: { contentType: "text", content: "hello bob" },
      });
      expect(message.senderId).toBe(alice.user.id);
      expect(message.content).toBe("hello bob");
      expect(message.readByUserIds).toEqual([]);

      const {
        chats: [aliceChat],
      } = yield* alice.client.chats.listChats({ urlParams: {} });
      expect(aliceChat!.lastMessage?.id).toBe(message.id);
      expect(aliceChat!.unreadCount).toBe(0);

      const {
        chats: [bobChat],
      } = yield* bob.client.chats.listChats({ urlParams: {} });
      expect(bobChat!.unreadCount).toBe(1);

      const forbidden = yield* eve.client.chats
        .createMessage({
          path: { id: chat.id },
          payload: { contentType: "text", content: "intruding" },
        })
        .pipe(Effect.either);
      expect(forbidden._tag).toBe("Left");
      if (forbidden._tag === "Left") {
        expect((forbidden.left as { _tag: string })._tag).toBe("Forbidden");
      }
    }),
  ));

test("createMessage rejects content over the max length", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const result = yield* alice.client.chats
        .createMessage({
          path: { id: chat.id },
          payload: { contentType: "text", content: "x".repeat(4001) },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
    }),
  ));

test("listMessages paginates oldest-first and is forbidden for non-participants", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const eve = yield* registerAndLogin("eve", "pw");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const sent = [];
      for (let i = 0; i < 5; i++) {
        sent.push(
          yield* alice.client.chats.createMessage({
            path: { id: chat.id },
            payload: { contentType: "text", content: `msg ${i}` },
          }),
        );
      }

      const page = yield* bob.client.chats.listMessages({
        path: { id: chat.id },
        urlParams: { offset: 0, limit: 3 },
      });
      expect(page.hasMore).toBe(true);
      expect(page.total).toBeUndefined();
      expect(page.messages.map((m) => m.id)).toEqual(
        sent.slice(0, 3).map((m) => m.id),
      );

      const pageWithTotal = yield* bob.client.chats.listMessages({
        path: { id: chat.id },
        urlParams: { offset: 0, limit: 3, includeTotal: "true" },
      });
      expect(pageWithTotal.total).toBe(5);

      const nextPage = yield* bob.client.chats.listMessages({
        path: { id: chat.id },
        urlParams: { offset: 3, limit: 3 },
      });
      expect(nextPage.hasMore).toBe(false);
      expect(nextPage.messages.map((m) => m.id)).toEqual(
        sent.slice(3, 5).map((m) => m.id),
      );

      const forbidden = yield* eve.client.chats
        .listMessages({ path: { id: chat.id }, urlParams: {} })
        .pipe(Effect.either);
      expect(forbidden._tag).toBe("Left");
      if (forbidden._tag === "Left") {
        expect((forbidden.left as { _tag: string })._tag).toBe("Forbidden");
      }
    }),
  ));

test("markRead marks messages up to a point as read and updates unreadCount + readByUserIds", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const m1 = yield* alice.client.chats.createMessage({
        path: { id: chat.id },
        payload: { contentType: "text", content: "one" },
      });
      const m2 = yield* alice.client.chats.createMessage({
        path: { id: chat.id },
        payload: { contentType: "text", content: "two" },
      });
      yield* alice.client.chats.createMessage({
        path: { id: chat.id },
        payload: { contentType: "text", content: "three" },
      });

      const {
        chats: [bobChatBefore],
      } = yield* bob.client.chats.listChats({ urlParams: {} });
      expect(bobChatBefore!.unreadCount).toBe(3);

      const afterRead = yield* bob.client.chats.markRead({
        path: { id: chat.id },
        payload: { messageId: m2.id },
      });
      expect(afterRead.unreadCount).toBe(1);

      const page = yield* alice.client.chats.listMessages({
        path: { id: chat.id },
        urlParams: {},
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
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        path: { id: chat.id },
        payload: { contentType: "text", content: "original" },
      });
      expect(message.updatedAt).toBe(message.createdAt);

      const edited = yield* alice.client.chats.updateMessage({
        path: { id: chat.id, messageId: message.id },
        payload: { contentType: "text", content: "edited" },
      });
      expect(edited.content).toBe("edited");
      expect(edited.updatedAt).toBeGreaterThanOrEqual(message.updatedAt);

      const forbidden = yield* bob.client.chats
        .updateMessage({
          path: { id: chat.id, messageId: message.id },
          payload: { contentType: "text", content: "hijacked" },
        })
        .pipe(Effect.either);
      expect(forbidden._tag).toBe("Left");
      if (forbidden._tag === "Left") {
        expect((forbidden.left as { _tag: string })._tag).toBe("Forbidden");
      }
    }),
  ));

test("updateMessage 404s for a message that doesn't belong to the given chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const chatAB = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const eve = yield* registerAndLogin("eve", "pw");
      const chatAE = yield* alice.client.chats.createDirectChat({
        payload: { userId: eve.user.id },
      });
      const messageInAB = yield* alice.client.chats.createMessage({
        path: { id: chatAB.id },
        payload: { contentType: "text", content: "hi bob" },
      });

      const result = yield* alice.client.chats
        .updateMessage({
          path: { id: chatAE.id, messageId: messageInAB.id },
          payload: { contentType: "text", content: "wrong chat" },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
      }
    }),
  ));

test("deleteMessage removes the message and its read receipts, and is forbidden for non-senders", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const message = yield* alice.client.chats.createMessage({
        path: { id: chat.id },
        payload: { contentType: "text", content: "delete me" },
      });
      yield* bob.client.chats.markRead({
        path: { id: chat.id },
        payload: { messageId: message.id },
      });

      const forbidden = yield* bob.client.chats
        .deleteMessage({ path: { id: chat.id, messageId: message.id } })
        .pipe(Effect.either);
      expect(forbidden._tag).toBe("Left");
      if (forbidden._tag === "Left") {
        expect((forbidden.left as { _tag: string })._tag).toBe("Forbidden");
      }

      yield* alice.client.chats.deleteMessage({
        path: { id: chat.id, messageId: message.id },
      });

      const page = yield* alice.client.chats.listMessages({
        path: { id: chat.id },
        urlParams: { includeTotal: "true" },
      });
      expect(page.messages.map((m) => m.id)).not.toContain(message.id);
      expect(page.total).toBe(0);
    }),
  ));

test("getChat 404s for a missing chat and is forbidden for non-participants", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const eve = yield* registerAndLogin("eve", "pw");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const missing = yield* alice.client.chats
        .getChat({ path: { id: 9999 } })
        .pipe(Effect.either);
      expect(missing._tag).toBe("Left");
      if (missing._tag === "Left") {
        expect((missing.left as { _tag: string })._tag).toBe("NotFound");
      }

      const forbidden = yield* eve.client.chats
        .getChat({ path: { id: chat.id } })
        .pipe(Effect.either);
      expect(forbidden._tag).toBe("Left");
      if (forbidden._tag === "Left") {
        expect((forbidden.left as { _tag: string })._tag).toBe("Forbidden");
      }
    }),
  ));

test("createDirectChat does not create duplicate chats when two requests race", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");

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

      const aliceChats = yield* alice.client.chats.listChats({ urlParams: {} });
      expect(aliceChats.chats).toHaveLength(1);
    }),
  ));

test("addParticipants does not exceed the group cap when two requests race", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
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
              path: { id: chat.id },
              payload: { participantIds: fillsTheCap.map((u) => u.id) },
            })
            .pipe(Effect.either),
          alice.client.chats
            .addParticipants({
              path: { id: chat.id },
              payload: { participantIds: [oneMore.id] },
            })
            .pipe(Effect.either),
        ],
        { concurrency: "unbounded" },
      );

      const outcomes = [fillResult, oneMoreResult];
      const succeeded = outcomes.filter((r) => r._tag === "Right");
      const failed = outcomes.filter((r) => r._tag === "Left");
      // Exactly one of the two racing requests must have been rejected —
      // both together would have exceeded the cap.
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect((failed[0] as { left: { _tag: string } }).left._tag).toBe(
        "InvalidChatRequest",
      );

      const finalChat = yield* alice.client.chats.getChat({
        path: { id: chat.id },
      });
      expect(finalChat.participants.length).toBeLessThanOrEqual(
        MAX_GROUP_PARTICIPANTS,
      );
    }),
  ));

test("deleting a group chat's creator sets createdBy to null instead of deleting the chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Survives", participantIds: [bob.user.id] },
      });

      const db = yield* Db;
      yield* Effect.tryPromise(() =>
        db.delete(users).where(eq(users.id, alice.user.id)),
      ).pipe(Effect.orDie);

      const survived = yield* bob.client.chats.getChat({
        path: { id: chat.id },
      });
      expect(survived.title).toBe("Survives");
      expect(survived.createdBy).toBeNull();
      expect(survived.participants.map((p) => p.userId)).toContain(bob.user.id);

      // With no creator left, renaming is now forbidden for everyone.
      const result = yield* bob.client.chats
        .updateChat({ path: { id: chat.id }, payload: { title: "Nope" } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Forbidden");
      }
    }),
  ));

test("every chats endpoint rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;

      const results = yield* Effect.all(
        [
          c.chats.listChats({ urlParams: {} }).pipe(Effect.either),
          c.chats.getChat({ path: { id: 1 } }).pipe(Effect.either),
          c.chats
            .createDirectChat({ payload: { userId: 1 } })
            .pipe(Effect.either),
          c.chats
            .createGroupChat({
              payload: { title: "x", participantIds: [1] },
            })
            .pipe(Effect.either),
          c.chats
            .updateChat({ path: { id: 1 }, payload: { title: "x" } })
            .pipe(Effect.either),
          c.chats
            .addParticipants({
              path: { id: 1 },
              payload: { participantIds: [1] },
            })
            .pipe(Effect.either),
          c.chats
            .listMessages({ path: { id: 1 }, urlParams: {} })
            .pipe(Effect.either),
          c.chats
            .createMessage({
              path: { id: 1 },
              payload: { contentType: "text", content: "hi" },
            })
            .pipe(Effect.either),
          c.chats.sendTyping({ path: { id: 1 } }).pipe(Effect.either),
          c.chats
            .markRead({ path: { id: 1 }, payload: { messageId: 1 } })
            .pipe(Effect.either),
          c.chats
            .updateMessage({
              path: { id: 1, messageId: 1 },
              payload: { contentType: "text", content: "hi" },
            })
            .pipe(Effect.either),
          c.chats
            .deleteMessage({ path: { id: 1, messageId: 1 } })
            .pipe(Effect.either),
        ],
        { concurrency: "unbounded" },
      );

      for (const result of results) {
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
        }
      }
    }),
  ));

test("createGroupChat's participant list is capped at the schema level", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
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
      const overCap = yield* alice.client.chats
        .createGroupChat({
          payload: {
            title: "Over cap",
            participantIds: pool
              .slice(0, MAX_GROUP_PARTICIPANTS)
              .map((u) => u.id),
          },
        })
        .pipe(Effect.either);
      expect(overCap._tag).toBe("Left");
    }),
  ));

test("addParticipants's participant list is capped at the schema level", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const chat = yield* alice.client.chats.createGroupChat({
        payload: { title: "Group", participantIds: [bob.user.id] },
      });
      const pool = yield* insertDummyUsers(MAX_GROUP_PARTICIPANTS);

      // A single addParticipants request can never legitimately add more
      // than MAX_GROUP_PARTICIPANTS - 1 people (the creator already takes
      // one slot) — this is rejected by the payload schema itself
      // (Schema.maxItems), before it ever reaches the handler's own cap
      // check.
      const overCap = yield* alice.client.chats
        .addParticipants({
          path: { id: chat.id },
          payload: { participantIds: pool.map((u) => u.id) },
        })
        .pipe(Effect.either);
      expect(overCap._tag).toBe("Left");
    }),
  ));

test("addParticipants rejects adding people to a direct chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const carol = yield* registerAndLogin("carol", "pw");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const result = yield* alice.client.chats
        .addParticipants({
          path: { id: chat.id },
          payload: { participantIds: [carol.user.id] },
        })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe(
          "InvalidChatRequest",
        );
      }
    }),
  ));

test("sendTyping succeeds for a participant", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      yield* alice.client.chats.sendTyping({ path: { id: chat.id } });
    }),
  ));

test("sendTyping is forbidden for a non-participant", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const eve = yield* registerAndLogin("eve", "pw");
      const chat = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });

      const result = yield* eve.client.chats
        .sendTyping({ path: { id: chat.id } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Forbidden");
      }
    }),
  ));

test("sendTyping 404s for a nonexistent chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const result = yield* alice.client.chats
        .sendTyping({ path: { id: 9999 } })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("NotFound");
      }
    }),
  ));

test("markRead 404s for a missing chat or a message from a different chat", () =>
  run(
    Effect.gen(function* () {
      const alice = yield* registerAndLogin("alice", "pw");
      const bob = yield* registerAndLogin("bob", "pw");
      const carol = yield* registerAndLogin("carol", "pw");

      const chatAB = yield* alice.client.chats.createDirectChat({
        payload: { userId: bob.user.id },
      });
      const messageInAB = yield* alice.client.chats.createMessage({
        path: { id: chatAB.id },
        payload: { contentType: "text", content: "hi bob" },
      });

      const missingChat = yield* alice.client.chats
        .markRead({
          path: { id: 9999 },
          payload: { messageId: messageInAB.id },
        })
        .pipe(Effect.either);
      expect(missingChat._tag).toBe("Left");
      if (missingChat._tag === "Left") {
        expect((missingChat.left as { _tag: string })._tag).toBe("NotFound");
      }

      const chatAC = yield* alice.client.chats.createDirectChat({
        payload: { userId: carol.user.id },
      });
      const messageInAC = yield* alice.client.chats.createMessage({
        path: { id: chatAC.id },
        payload: { contentType: "text", content: "hi carol" },
      });

      // messageInAC exists, but not in chatAB.
      const wrongChat = yield* bob.client.chats
        .markRead({
          path: { id: chatAB.id },
          payload: { messageId: messageInAC.id },
        })
        .pipe(Effect.either);
      expect(wrongChat._tag).toBe("Left");
      if (wrongChat._tag === "Left") {
        expect((wrongChat.left as { _tag: string })._tag).toBe("NotFound");
      }
    }),
  ));
