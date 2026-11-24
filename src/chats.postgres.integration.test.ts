import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect, Layer } from "effect";
import { ChatApi } from "./Api.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import {
  attachments,
  chatInvites,
  chatParticipants,
  chats,
  users,
} from "./db/schema.ts";
import * as schema from "./db/schema.ts";
import { Jwt, JwtLive } from "./Jwt.ts";
import { makeTestRun } from "./testApi.ts";
import { resetTestDb } from "./testDb.ts";

// addParticipants and joinChatViaInvite close their check-then-write races
// (createDirectChat relies on a unique index instead) with `serializable` transactions, which Postgres
// enforces by aborting the loser (40001) for `serializableTransaction` to
// retry (issue #654). Every other test runs on PGlite, a single connection
// whose transactions never overlap — so none of that is exercised there.
// This file drives the same handlers against a real Postgres through a
// connection pool, so concurrent requests really do race. It needs a
// throwaway database at TEST_DATABASE_URL (it migrates and truncates it), so
// it's skipped unless one is configured (CI's `unit` job provides one).
const databaseUrl = process.env.TEST_DATABASE_URL;

const describeIfPostgres = databaseUrl ? describe : describe.skip;

describeIfPostgres("chat transactions on real Postgres", () => {
  // Only ever undefined when the suite is skipped.
  const bunDb = databaseUrl ? drizzle(databaseUrl, { schema }) : undefined;
  const db = bunDb as DrizzleDb;
  const migrated = bunDb && migrate(bunDb, { migrationsFolder: "./drizzle" });

  const run = makeTestRun({ db: Layer.succeed(Db, db) });

  beforeEach(async () => {
    await migrated;
    await resetTestDb(db);
  });

  afterAll(() => bunDb?.$client.close());

  // Users are inserted directly and handed signed tokens: these tests need
  // dozens of them, far past register's per-IP rate limit.
  const createUsers = (prefix: string, n: number) =>
    Effect.gen(function* () {
      const rows = yield* query(() =>
        db
          .insert(users)
          .values(
            Array.from({ length: n }, (_, i) => ({
              username: `${prefix}${i}`,
              passwordHash: "unused",
            })),
          )
          .returning(),
      );
      const jwt = yield* Effect.service(Jwt).pipe(Effect.provide(JwtLive));
      return yield* Effect.forEach(rows, (user) =>
        Effect.gen(function* () {
          const accessToken = yield* jwt.signAccessToken(user);
          const client = yield* HttpApiClient.make(ChatApi, {
            baseUrl: "http://localhost",
            transformClient: (client) =>
              HttpClient.mapRequest(
                client,
                HttpClientRequest.setHeader(
                  "Authorization",
                  `Bearer ${accessToken}`,
                ),
              ),
          });
          return { user, client };
        }),
      );
    });

  const createUser = (username: string) =>
    createUsers(username, 1).pipe(Effect.map((created) => created[0]!));

  const query = <A>(f: () => Promise<A>) =>
    Effect.tryPromise(f).pipe(Effect.orDie);

  // Not a chat transaction, but the same kind of race: refresh rotation is
  // made single-use by a conditional UPDATE, and only a real pool overlaps
  // the two requests' transactions so the loser waits on the winner's row
  // lock and re-checks `revoked_at IS NULL` (issue #650).
  test("concurrent refreshes with one token give at most one success", () =>
    run(
      Effect.gen(function* () {
        const { client } = yield* createUser("unused");
        yield* client.users.register({
          payload: { username: "rotator", password: "pw-rotator1" },
        });
        const { refreshToken } = yield* client.users.login({
          payload: { username: "rotator", password: "pw-rotator1" },
        });

        const results = yield* Effect.all(
          Array.from({ length: 6 }, () =>
            client.users
              .refresh({ payload: { refreshToken } })
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
        const winners = results.filter((r) => r._tag === "Success");
        expect(winners.length).toBeLessThanOrEqual(1);
        for (const winner of winners) {
          if (winner._tag !== "Success") continue;
          const after = yield* client.users
            .refresh({ payload: { refreshToken: winner.success.refreshToken } })
            .pipe(Effect.flip);
          expect(after._tag).toBe("InvalidCredentials");
        }
      }),
    ));

  // Not a race either: the wire driver must read back the instant it wrote,
  // and the one the database writes itself, whatever the session's time zone
  // (issue #939).
  test("timestamps are the same instants in any session time zone", async () => {
    const written = new Date("2026-03-29T00:30:00.123Z");
    await db.transaction(async (tx) => {
      await tx.execute("set local time zone 'Pacific/Kiritimati'");
      const before = Date.now();
      const [user] = await tx
        .insert(users)
        .values({
          username: "kiri",
          passwordHash: "unused",
          lastActiveAt: written,
        })
        .returning();
      expect(user!.lastActiveAt).toEqual(written);
      const age = user!.createdAt!.getTime() - before;
      expect(Math.abs(age)).toBeLessThan(60_000);
      expect(await tx.$count(users, eq(users.lastActiveAt, written))).toBe(1);
    });
    const [read] = await db.select().from(users);
    expect(read!.lastActiveAt).toEqual(written);
  });

  // Nor is this: only the wire driver reads a bigint as a string where
  // Drizzle doesn't map the column, as in raw SQL (issue #940).
  test("message, reaction and notification ids above 2^31 stay numbers", () =>
    run(
      Effect.gen(function* () {
        const start = 3_000_000_000;
        for (const table of ["messages", "likes", "notifications"])
          yield* query(() =>
            db.execute(sql.raw(`select setval('${table}_id_seq', ${start})`)),
          );
        const alice = yield* createUser("alice");
        const bob = yield* createUser("bob");
        const chat = yield* alice.client.chats.createGroupChat({
          payload: { title: "Group", participantIds: [bob.user.id] },
        });
        yield* bob.client.chats.acceptChatRequest({ params: { id: chat.id } });
        const params = { id: chat.id };
        const send = (content: string, parentMessageId?: number) =>
          alice.client.chats.createMessage({
            params,
            payload: {
              body: content,
              ...(parentMessageId === undefined ? {} : { parentMessageId }),
            },
          });
        const first = yield* send("walrus one");
        expect(first.id).toBeGreaterThan(start);
        const reply = yield* send("walrus two", first.id);
        expect(reply.parentMessage?.id).toBe(first.id);

        const listed = yield* bob.client.chats.listChats({ query: {} });
        expect(listed.chats[0]?.lastMessage?.id).toBe(reply.id);
        expect(listed.chats[0]?.unreadCount).toBe(2);
        const read = yield* bob.client.chats.markRead({
          params,
          payload: { messageId: first.id },
        });
        expect(read.unreadCount).toBe(1);

        const at = { params: { id: chat.id, messageId: first.id } };
        yield* bob.client.chats.addMessageReaction({
          ...at,
          payload: { emoji: "❤️" },
        });
        yield* alice.client.chats.pinMessage({
          params,
          payload: { messageId: first.id },
        });
        yield* alice.client.chats.starMessage(at);
        const forward = yield* alice.client.chats.forwardMessage({
          ...at,
          payload: { targetChatIds: [chat.id] },
        });
        expect(forward.results[0]?.message?.id).toBeGreaterThan(reply.id);

        const newest = yield* bob.client.chats.listMessages({
          params,
          query: { limit: 2 },
        });
        const older = yield* bob.client.chats.listMessages({
          params,
          query: { before: newest.earliestCursor! },
        });
        expect(older.messages.map((m) => m.id)).toEqual([first.id]);
        expect(older.messages[0]).toMatchObject({ pinned: true });
        expect(older.messages[0]?.readByUserIds).toEqual([bob.user.id]);

        const found = yield* bob.client.search.searchMessages({
          query: { q: "walrus", limit: 1 },
        });
        expect(found.results[0]?.id).toBeGreaterThan(reply.id);

        // A joiner's watermark and the activity row's place are raw SQL too.
        const carol = yield* createUser("carol");
        yield* alice.client.chats.addParticipants({
          params,
          payload: { participantIds: [carol.user.id] },
        });
        const events = yield* alice.client.chats.listChatEvents({ params });
        expect(events.at(-1)?.afterMessageId).toBeGreaterThan(reply.id);
        const rows = yield* query(() =>
          db
            .select({ at: chatParticipants.lastReadMessageId })
            .from(chatParticipants)
            .where(eq(chatParticipants.userId, carol.user.id)),
        );
        expect(rows[0]?.at).toBeGreaterThan(reply.id);

        const post = yield* alice.client.posts.createPost({
          payload: { body: "hello" },
        });
        yield* bob.client.comments.addPostReaction({
          params: { id: post.id },
          payload: { emoji: "❤️" },
        });
        const inbox = yield* alice.client.notifications.listNotifications({
          query: {},
        });
        expect(inbox.notifications[0]?.id).toBeGreaterThan(start);
      }),
    ));

  // Claims of one attachment take turns on its row lock, across posts and
  // messages (issue #896).
  test("concurrent posts and messages with one attachment store it once", () =>
    run(
      Effect.gen(function* () {
        const alice = yield* createUser("alice");
        const bob = yield* createUser("bob");
        const chat = yield* alice.client.chats.createDirectChat({
          payload: { userId: bob.user.id },
        });
        const upload = () =>
          query(() =>
            db
              .insert(attachments)
              .values({
                uploaderId: alice.user.id,
                filename: "a.png",
                mimeType: "image/png",
                size: 1,
                storageKey: "attachments/a",
              })
              .returning(),
          ).pipe(Effect.map((rows) => rows[0]!.id));
        const send = (
          i: number,
          payload: {
            body: string;
            attachmentId: number;
            clientId?: string;
          },
        ) =>
          Effect.gen(function* () {
            return i % 2 === 0
              ? yield* alice.client.posts.createPost({ payload })
              : yield* alice.client.chats.createMessage({
                  params: { id: chat.id },
                  payload,
                });
          });
        const body = (attachmentId: number) => ({
          body: "",
          attachmentId,
        });

        const shared = yield* upload();
        const results = yield* Effect.all(
          Array.from({ length: 6 }, (_, i) =>
            send(i, body(shared)).pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
        expect(results.filter((r) => r._tag === "Success").length).toBe(1);
        for (const r of results)
          if (r._tag === "Failure")
            expect(r.failure._tag).toBe("AttachmentInUse");

        // A double-sent create under one key is the same row, not a conflict.
        for (const kind of [0, 1]) {
          const payload = { ...body(yield* upload()), clientId: "same" };
          const twins = yield* Effect.all(
            Array.from({ length: 4 }, () => send(kind, payload)),
            { concurrency: "unbounded" },
          );
          expect(new Set(twins.map((t) => t.id)).size).toBe(1);
        }
      }),
    ));

  test("concurrent createDirectChat for one pair all succeed with one chat", () =>
    run(
      Effect.gen(function* () {
        const alice = yield* createUser("alice");
        const bob = yield* createUser("bob");

        // Both sides double-tapping "Message" at once.
        const results = yield* Effect.all(
          Array.from({ length: 6 }, (_, i) =>
            (i % 2 === 0 ? alice : bob).client.chats.createDirectChat({
              payload: { userId: (i % 2 === 0 ? bob : alice).user.id },
            }),
          ),
          { concurrency: "unbounded" },
        );

        expect(new Set(results.map((chat) => chat.id)).size).toBe(1);
        const [direct] = yield* query(() =>
          db.select({ n: count() }).from(chats).where(eq(chats.type, "direct")),
        );
        expect(direct?.n).toBe(1);

        // The index itself refuses a second one, not just the handler.
        const pair = [alice.user.id, bob.user.id];
        const second = yield* Effect.tryPromise(() =>
          db.insert(chats).values({
            type: "direct",
            directUserLow: Math.min(...pair),
            directUserHigh: Math.max(...pair),
          }),
        ).pipe(Effect.result);
        expect(second._tag).toBe("Failure");
      }),
    ));

  test("concurrent createDirectChat for different pairs all succeed", () =>
    run(
      Effect.gen(function* () {
        const left = yield* createUsers("left", 12);
        const right = yield* createUsers("right", 12);

        const results = yield* Effect.all(
          left.map((user, i) =>
            user.client.chats.createDirectChat({
              payload: { userId: right[i]!.user.id },
            }),
          ),
          { concurrency: "unbounded" },
        );

        expect(new Set(results.map((chat) => chat.id)).size).toBe(12);
      }),
    ));

  test("concurrent invite joins by different users all succeed", () =>
    run(
      Effect.gen(function* () {
        const [owner, member] = yield* createUsers("owner", 2);
        const joiners = yield* createUsers("joiner", 8);
        const chat = yield* owner!.client.chats.createGroupChat({
          payload: { title: "Group", participantIds: [member!.user.id] },
        });
        const invite = yield* owner!.client.chats.createChatInvite({
          params: { id: chat.id },
          payload: {},
        });

        yield* Effect.all(
          joiners.map((joiner) =>
            joiner.client.chats.joinChatViaInvite({
              params: { code: invite.code },
            }),
          ),
          { concurrency: "unbounded" },
        );

        const members = yield* query(() =>
          db
            .select({ userId: chatParticipants.userId })
            .from(chatParticipants)
            .where(eq(chatParticipants.chatId, chat.id)),
        );
        expect(members.map((m) => m.userId).sort()).toEqual(
          [owner!, member!, ...joiners].map((u) => u.user.id).sort(),
        );
        const [row] = yield* query(() =>
          db
            .select({ useCount: chatInvites.useCount })
            .from(chatInvites)
            .where(eq(chatInvites.id, invite.id)),
        );
        expect(row?.useCount).toBe(joiners.length);
      }),
    ));

  test("a double-tapped invite join succeeds once, without a 500", () =>
    run(
      Effect.gen(function* () {
        const [owner, member] = yield* createUsers("owner", 2);
        const carol = yield* createUser("carol");
        const chat = yield* owner!.client.chats.createGroupChat({
          payload: { title: "Group", participantIds: [member!.user.id] },
        });
        const invite = yield* owner!.client.chats.createChatInvite({
          params: { id: chat.id },
          payload: {},
        });

        const results = yield* Effect.all(
          Array.from({ length: 4 }, () =>
            carol.client.chats.joinChatViaInvite({
              params: { code: invite.code },
            }),
          ),
          { concurrency: "unbounded" },
        );

        expect(results.every((joined) => joined.id === chat.id)).toBe(true);
        const [membership] = yield* query(() =>
          db
            .select({ n: count() })
            .from(chatParticipants)
            .where(
              and(
                eq(chatParticipants.chatId, chat.id),
                eq(chatParticipants.userId, carol.user.id),
              ),
            ),
        );
        expect(membership?.n).toBe(1);
        const [row] = yield* query(() =>
          db
            .select({ useCount: chatInvites.useCount })
            .from(chatInvites)
            .where(eq(chatInvites.id, invite.id)),
        );
        expect(row?.useCount).toBe(1);
      }),
    ));
});
