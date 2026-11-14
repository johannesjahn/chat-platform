import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { ChatApi, DEFAULT_CHATS_LIMIT } from "../Api.ts";
import { Db } from "../Db.ts";
import { messages, users } from "../db/schema.ts";

// Helpers shared by the chats test files (src/chats/*.test.ts, split from
// chats.test.ts by area in issue #811). Each test file still calls
// `makeTestRun()` itself: it registers that file's own database hooks.

export const makeClient = HttpApiClient.make(ChatApi, {
  baseUrl: "http://localhost",
});

const makeAuthedClient = (token: string) =>
  HttpApiClient.make(ChatApi, {
    baseUrl: "http://localhost",
    transformClient: (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
      ),
  });

export const registerAndLogin = (username: string, password: string) =>
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
export const promoteToAdmin = (username: string, password: string) =>
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

// Inserts bare user rows directly (bypassing register's argon2id hashing,
// which is far too slow to do MAX_GROUP_PARTICIPANTS times per test) — these
// users only need to exist as participant targets, never to authenticate.
export const insertDummyUsers = (count: number) =>
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

// Seeds `total` text messages from `senderId` straight into the database —
// far quicker than the API for the history-size tests below. Chunked so no
// single INSERT nears Postgres's bind-parameter limit.
export const seedMessages = (chatId: number, senderId: number, total: number) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const now = new Date();
    for (let start = 0; start < total; start += 5000) {
      const size = Math.min(5000, total - start);
      yield* Effect.tryPromise(() =>
        db.insert(messages).values(
          Array.from({ length: size }, (_, i) => ({
            chatId,
            senderId,
            contentType: "text" as const,
            content: `seeded ${start + i}`,
            createdAt: now,
            updatedAt: now,
          })),
        ),
      ).pipe(Effect.orDie);
    }
  });

export const medianMs = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

// Finds one emoji's summary in a `reactions` array, or a zero/false default
// if that emoji has no reactions at all (mirrors the same helper in
// engagement.test.ts — see ReactionSummary in reactions.ts).
export const reactionOf = (
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

// Issue #756: a DM with unread messages pushed off the first page of the
// chat list by `DEFAULT_CHATS_LIMIT` newer chats that alice has read.
export const buryUnreadDirectChat = Effect.gen(function* () {
  const alice = yield* registerAndLogin("alice", "pw-testpass");
  const bob = yield* registerAndLogin("bob", "pw-testpass");
  const dm = yield* bob.client.chats.createDirectChat({
    payload: { userId: alice.user.id },
  });
  for (const content of ["one", "two", "three"]) {
    yield* bob.client.chats.createMessage({
      params: { id: dm.id },
      payload: { contentType: "text", content },
    });
  }
  for (let i = 0; i < DEFAULT_CHATS_LIMIT; i++) {
    const group = yield* bob.client.chats.createGroupChat({
      payload: { title: `Group ${i}`, participantIds: [alice.user.id] },
    });
    const message = yield* bob.client.chats.createMessage({
      params: { id: group.id },
      payload: { contentType: "text", content: `hello ${i}` },
    });
    yield* alice.client.chats.markRead({
      params: { id: group.id },
      payload: { messageId: message.id },
    });
  }
  return { alice, bob, dm };
});
