import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect, Layer } from "effect";
import { ChatApi } from "./Api.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { chatInvites, chatParticipants, chats, users } from "./db/schema.ts";
import * as schema from "./db/schema.ts";
import { Jwt, JwtLive } from "./Jwt.ts";
import { makeTestRun } from "./testApi.ts";
import { resetTestDb } from "./testDb.ts";
import { signUpTestUser } from "./testUsers.ts";

// createDirectChat, addParticipants and joinChatViaInvite close their
// check-then-write races with `serializable` transactions, which Postgres
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
        const { refreshToken } = yield* signUpTestUser("rotator");

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
      }),
    ));

  test("concurrent createDirectChat for different pairs all succeed", () =>
    run(
      Effect.gen(function* () {
        // Serializable isolation tracks reads by index page, so even
        // requests for unrelated pairs abort each other.
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
