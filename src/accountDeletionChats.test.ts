import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect, Layer } from "effect";
import { eq } from "drizzle-orm";
import { ChatApi } from "./Api.ts";
import { Db } from "./Db.ts";
import { chats, users } from "./db/schema.ts";
import { PubSub } from "./PubSub.ts";
import { makeTestRun } from "./testApi.ts";
import { UserLocator } from "./UserLocator.ts";

// What deleting an account does to the chats it was in (issue #895): it
// leaves each one the way a leave would — a group it owned passes to the
// next member, everyone left behind gets `chat_updated`, and a direct chat
// with it can't be sent to any more. Both endpoints that delete accounts
// (`DELETE /users/me` and the admin `DELETE /users/:id`) go through it.

type Envelope = {
  scope: string;
  userIds?: number[];
  event?: { type: string; [key: string]: unknown };
};
let published: Envelope[] = [];
const RecordingPubSubLive = Layer.succeed(PubSub, {
  publish: (_channel, message) =>
    Effect.sync(() => {
      published.push(JSON.parse(message) as Envelope);
    }),
  subscribe: () => Effect.void,
  onReconnect: () => Effect.void,
  unsubscribe: () => Effect.void,
  ping: Effect.void,
});

const run = makeTestRun({
  pubSub: RecordingPubSubLive,
  beforeEach: () => {
    published = [];
  },
});

const makeClient = HttpApiClient.make(ChatApi, { baseUrl: "http://localhost" });

const password = "pw-testpass";

const loginAs = (username: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    return yield* HttpApiClient.make(ChatApi, {
      baseUrl: "http://localhost",
      transformClient: (inner) =>
        HttpClient.mapRequest(
          inner,
          HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
        ),
    });
  });

const registerAndLogin = (username: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const user = yield* c.users.register({ payload: { username, password } });
    // Online, or `notifyUsers` would have no one to publish to.
    yield* (yield* UserLocator).claim(user.id, "test-instance");
    return { user, client: yield* loginAs(username) };
  });

const promoteToAdmin = (userId: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    yield* Effect.promise(() =>
      db.update(users).set({ role: "admin" }).where(eq(users.id, userId)),
    );
  });

// The `chat_updated` events published since `from`, with their recipients.
const chatUpdates = (chatId: number, from: number) =>
  published
    .slice(from)
    .filter(
      (e) => e.event?.type === "chat_updated" && e.event["chatId"] === chatId,
    )
    .map((e): Record<string, unknown> & { to: number[] } => ({
      to: [...(e.userIds ?? [])].sort(),
      ...e.event,
    }));

// Eve has a direct chat with Alice and owns a group with Alice and Bob —
// the scenario from the issue. Eve knows both first, so neither is a
// message request in the group.
const eveWithChats = Effect.gen(function* () {
  const eve = yield* registerAndLogin("eve");
  const alice = yield* registerAndLogin("alice");
  const bob = yield* registerAndLogin("bob");
  const direct = yield* eve.client.chats.createDirectChat({
    payload: { userId: alice.user.id },
  });
  yield* eve.client.chats.createDirectChat({
    payload: { userId: bob.user.id },
  });
  const group = yield* eve.client.chats.createGroupChat({
    payload: {
      title: "Eve's group",
      participantIds: [alice.user.id, bob.user.id],
    },
  });
  // Alice and Bob join together; the hand-off breaks that tie by user id,
  // so Alice inherits the group.
  return { eve, alice, bob, direct, group };
});

type Session = Effect.Success<ReturnType<typeof registerAndLogin>>;

const ENDPOINTS = ["DELETE /users/me", "DELETE /users/:id (admin)"] as const;

const deleteThrough = (endpoint: (typeof ENDPOINTS)[number], eve: Session) =>
  endpoint === "DELETE /users/me"
    ? eve.client.users.deleteAccount({ payload: { password } })
    : Effect.gen(function* () {
        const { user } = yield* registerAndLogin("admin");
        yield* promoteToAdmin(user.id);
        // Log in again, so the token carries the admin role.
        const admin = yield* loginAs("admin");
        yield* admin.users.deleteUser({ params: { id: eve.user.id } });
      });

for (const endpoint of ENDPOINTS) {
  test(`${endpoint} hands Eve's group to the next member and tells everyone left`, () =>
    run(
      Effect.gen(function* () {
        const { eve, alice, bob, group } = yield* eveWithChats;
        const mark = published.length;

        yield* deleteThrough(endpoint, eve);

        const after = yield* alice.client.chats.getChat({
          params: { id: group.id },
        });
        expect(after.createdBy).toBe(alice.user.id);
        const roles = Object.fromEntries(
          after.participants.map((p) => [p.userId, p.role]),
        );
        expect(roles).toEqual({
          [alice.user.id]: "owner",
          [bob.user.id]: "member",
        });
        expect(after.version).toBeGreaterThan(group.version);

        expect(chatUpdates(group.id, mark)).toEqual([
          {
            to: [alice.user.id, bob.user.id].sort(),
            type: "chat_updated",
            chatId: group.id,
            version: after.version,
          },
        ]);

        // The new owner can manage it — no one has to claim it first.
        const renamed = yield* alice.client.chats.updateChat({
          params: { id: group.id },
          payload: { title: "Alice's group now" },
        });
        expect(renamed.title).toBe("Alice's group now");
      }),
    ));

  test(`${endpoint} leaves Eve's direct chats read-only and tells the partner`, () =>
    run(
      Effect.gen(function* () {
        const { eve, alice, direct } = yield* eveWithChats;
        const mark = published.length;

        yield* deleteThrough(endpoint, eve);

        const after = yield* alice.client.chats.getChat({
          params: { id: direct.id },
        });
        expect(after.type).toBe("direct");
        expect(after.participants.map((p) => p.userId)).toEqual([
          alice.user.id,
        ]);
        expect(chatUpdates(direct.id, mark)).toEqual([
          {
            to: [alice.user.id],
            type: "chat_updated",
            chatId: direct.id,
            version: after.version,
          },
        ]);

        const send = yield* alice.client.chats
          .createMessage({
            params: { id: direct.id },
            payload: { body: "anyone there?" },
          })
          .pipe(Effect.flip);
        expect(send._tag).toBe("Forbidden");
        expect((send as { message: string }).message).toContain(
          "account was deleted",
        );
      }),
    ));
}

test("a forward into a direct chat with a deleted account is that target's unavailable", () =>
  run(
    Effect.gen(function* () {
      const { eve, alice, group, direct } = yield* eveWithChats;
      const source = yield* alice.client.chats.createMessage({
        params: { id: group.id },
        payload: { body: "pass it on" },
      });
      yield* eve.client.users.deleteAccount({ payload: { password } });

      const { results } = yield* alice.client.chats.forwardMessage({
        params: { id: group.id, messageId: source.id },
        payload: { targetChatIds: [direct.id, group.id] },
      });
      expect(results.map((r) => [r.chatId, r.error?.reason ?? null])).toEqual([
        [direct.id, "unavailable"],
        [group.id, null],
      ]);
    }),
  ));

test("deleting the last member of a group deletes the group", () =>
  run(
    Effect.gen(function* () {
      const { eve, alice, bob, group } = yield* eveWithChats;
      yield* alice.client.chats.leaveChat({ params: { id: group.id } });
      yield* bob.client.chats.leaveChat({ params: { id: group.id } });

      yield* eve.client.users.deleteAccount({ payload: { password } });

      const db = yield* Db;
      const rows = yield* Effect.promise(() =>
        db.select().from(chats).where(eq(chats.id, group.id)),
      );
      expect(rows).toEqual([]);
    }),
  ));
