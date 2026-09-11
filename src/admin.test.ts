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
import {
  ChatApi,
  MAX_ADMIN_TIMELINE_DAYS,
  type AdminActivityWindow,
} from "./Api.ts";
import { AdminHandlerLive } from "./AdminHandler.ts";
import { AttachmentsHandlerLive } from "./AttachmentsHandler.ts";
import { AttachmentStorageLive } from "./AttachmentStorage.ts";
import { AuthenticationLive, TokenVersionCacheLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { SearchHandlerLive } from "./SearchHandler.ts";
import { Db } from "./Db.ts";
import { SanitizeDecodeErrorsLive } from "./DecodeErrorSanitizer.ts";
import { JwtLive } from "./Jwt.ts";
import { EngagementHandlerLive } from "./EngagementHandler.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { InMemoryPresenceStoreLive } from "./Presence.ts";
import { InMemoryPubSubLive } from "./PubSub.ts";
import { InMemoryRateLimiterLive } from "./RateLimiter.ts";
import { RealtimeConnectionsLive } from "./Realtime.ts";
import { RealtimeHandlerLive } from "./RealtimeHandler.ts";
import { makeTestDbAccessor, resetTestDb } from "./testDb.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import { VersionHandlerLive } from "./VersionHandler.ts";
import { InMemoryWsTicketLive } from "./WsTicket.ts";
import {
  attachments,
  chats,
  comments,
  likes,
  messages,
  posts,
  users,
} from "./db/schema.ts";

// JwtLive reads JWT_SECRET from config; provide a deterministic test secret.
process.env.JWT_SECRET ??= "test-secret";

const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(PostsHandlerLive),
  Layer.provide(EngagementHandlerLive),
  Layer.provide(ChatsHandlerLive),
  Layer.provide(SearchHandlerLive),
  Layer.provide(AttachmentsHandlerLive),
  Layer.provide(VersionHandlerLive),
  Layer.provide(AdminHandlerLive),
  Layer.provide(RealtimeHandlerLive),
  Layer.provide(RealtimeConnectionsLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(TokenVersionCacheLive),
  Layer.provide(InMemoryPresenceStoreLive),
  Layer.provide(InMemoryRateLimiterLive),
  Layer.provide(JwtLive),
  Layer.provide(SanitizeDecodeErrorsLive),
  Layer.provide(InMemoryWsTicketLive),
  Layer.provide(AttachmentStorageLive),
);

const { getTestDb } = makeTestDbAccessor();

// Same shape as posts.test.ts's harness: `effect` also gets `Db` directly,
// sharing the API layer's in-memory instance, so a test can seed rows with
// back-dated timestamps (which no endpoint lets it do) and promote a user to
// admin out-of-band the way production does.
const run = async <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | Db>,
): Promise<A> => {
  const db = await getTestDb();
  await resetTestDb(db);
  const TestDbLive = Layer.succeed(Db, db);

  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(
      ApiLive.pipe(
        Layer.provide(TestDbLive),
        Layer.provide(InMemoryPubSubLive),
      ),
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
    return { user, accessToken };
  });

// Registration always creates a "user", and the role is baked into the JWT
// at sign time — so promoting has to happen in the DB and the user has to
// log in again for a token that reflects it (same as posts.test.ts).
const registerAdmin = (username: string, password: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const db = yield* Db;
    const user = yield* c.users.register({ payload: { username, password } });
    yield* Effect.tryPromise(() =>
      db
        .update(users)
        .set({ role: "admin" })
        .where(eq(users.username, username)),
    ).pipe(Effect.orDie);
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    return { user, accessToken };
  });

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

// Back-dated content across all four activity types, seeded directly rather
// than through the API — the endpoints always stamp "now", and every window
// and timeline assertion below depends on rows sitting at a known age.
const seedActivity = Effect.gen(function* () {
  const db = yield* Db;
  const [fresh, recent, old] = yield* Effect.promise(() =>
    db
      .insert(users)
      .values([
        { username: "seed-fresh", passwordHash: "x", createdAt: daysAgo(0.5) },
        { username: "seed-recent", passwordHash: "x", createdAt: daysAgo(3) },
        { username: "seed-old", passwordHash: "x", createdAt: daysAgo(45) },
      ])
      .returning({ id: users.id }),
  );

  // `fresh` posted 12 hours ago — inside every window.
  const [post] = yield* Effect.promise(() =>
    db
      .insert(posts)
      .values({
        authorId: fresh!.id,
        contentType: "text",
        content: "hello",
        createdAt: daysAgo(0.5),
        updatedAt: daysAgo(0.5),
      })
      .returning({ id: posts.id }),
  );

  // `recent` commented 3 days ago — inside 7d/30d, outside 1d.
  yield* Effect.promise(() =>
    db.insert(comments).values({
      postId: post!.id,
      authorId: recent!.id,
      content: "nice",
      createdAt: daysAgo(3),
      updatedAt: daysAgo(3),
    }),
  );

  // `old` reacted 45 days ago — outside every window, but still counted in
  // the lifetime totals.
  yield* Effect.promise(() =>
    db.insert(likes).values({
      userId: old!.id,
      postId: post!.id,
      createdAt: daysAgo(45),
    }),
  );

  const [chat] = yield* Effect.promise(() =>
    db.insert(chats).values({ type: "direct" }).returning({ id: chats.id }),
  );
  // `fresh` messaged 10 days ago — inside 30d only. Combined with the post
  // above this is also what proves activeUsers dedupes: `fresh` is active in
  // the 30d window through two different content types but counts once.
  yield* Effect.promise(() =>
    db.insert(messages).values({
      chatId: chat!.id,
      senderId: fresh!.id,
      contentType: "text",
      content: "hi",
      createdAt: daysAgo(10),
      updatedAt: daysAgo(10),
    }),
  );

  yield* Effect.promise(() =>
    db.insert(attachments).values([
      {
        uploaderId: fresh!.id,
        filename: "a.png",
        mimeType: "image/png",
        size: 1000,
        storageKey: "attachments/a",
        createdAt: daysAgo(1),
      },
      {
        uploaderId: recent!.id,
        filename: "b.png",
        mimeType: "image/png",
        size: 2345,
        storageKey: "attachments/b",
        createdAt: daysAgo(2),
      },
    ]),
  );

  return { fresh: fresh!.id, recent: recent!.id, old: old!.id };
});

const windowOf = (
  activity: ReadonlyArray<AdminActivityWindow>,
  label: AdminActivityWindow["window"],
) => activity.find((entry) => entry.window === label)!;

test("getAdminStats rejects an unauthenticated request", () =>
  run(
    Effect.gen(function* () {
      const c = yield* makeClient;
      const result = yield* c.admin
        .getAdminStats({ urlParams: {} })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Unauthorized");
      }
    }),
  ));

test("getAdminStats rejects a non-admin caller with 403 Forbidden", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAndLogin("regular", "s3cret-pw");
      const c = yield* makeAuthedClient(accessToken);
      const result = yield* c.admin
        .getAdminStats({ urlParams: {} })
        .pipe(Effect.either);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect((result.left as { _tag: string })._tag).toBe("Forbidden");
      }
    }),
  ));

test("getAdminStats reports lifetime totals across every content type", () =>
  run(
    Effect.gen(function* () {
      yield* seedActivity;
      const { accessToken } = yield* registerAdmin("root", "s3cret-pw");
      const c = yield* makeAuthedClient(accessToken);

      const stats = yield* c.admin.getAdminStats({ urlParams: {} });

      // 3 seeded + the admin itself.
      expect(stats.totals.users).toBe(4);
      expect(stats.totals.admins).toBe(1);
      expect(stats.totals.posts).toBe(1);
      expect(stats.totals.comments).toBe(1);
      expect(stats.totals.chats).toBe(1);
      expect(stats.totals.messages).toBe(1);
      expect(stats.totals.reactions).toBe(1);
      expect(stats.totals.attachments).toBe(2);
      expect(stats.totals.attachmentBytes).toBe(3345);
      expect(stats.generatedAt).toBeGreaterThan(0);
    }),
  ));

test("getAdminStats counts new content per trailing window, and active users deduped across content types", () =>
  run(
    Effect.gen(function* () {
      yield* seedActivity;
      const { accessToken } = yield* registerAdmin("root", "s3cret-pw");
      const c = yield* makeAuthedClient(accessToken);

      const { activity } = yield* c.admin.getAdminStats({ urlParams: {} });
      expect(activity.map((entry) => entry.window)).toEqual([
        "1d",
        "7d",
        "30d",
      ]);

      const day = windowOf(activity, "1d");
      // The post from 12h ago, plus `seed-fresh` and the just-registered
      // admin as new signups.
      expect(day.newPosts).toBe(1);
      expect(day.newComments).toBe(0);
      expect(day.newMessages).toBe(0);
      expect(day.newReactions).toBe(0);
      expect(day.newUsers).toBe(2);
      expect(day.activeUsers).toBe(1);

      const week = windowOf(activity, "7d");
      expect(week.newPosts).toBe(1);
      expect(week.newComments).toBe(1);
      expect(week.newUsers).toBe(3);
      expect(week.activeUsers).toBe(2);

      const month = windowOf(activity, "30d");
      expect(month.newMessages).toBe(1);
      expect(month.newReactions).toBe(0); // the only reaction is 45 days old
      expect(month.newUsers).toBe(3); // `seed-old` signed up 45 days ago
      // `seed-fresh` posted *and* messaged inside 30d but counts once;
      // `seed-recent` commented. `seed-old`'s reaction is outside the window.
      expect(month.activeUsers).toBe(2);
    }),
  ));

test("getAdminStats returns a zero-filled daily timeline ending today", () =>
  run(
    Effect.gen(function* () {
      yield* seedActivity;
      const { accessToken } = yield* registerAdmin("root", "s3cret-pw");
      const c = yield* makeAuthedClient(accessToken);

      const { timeline } = yield* c.admin.getAdminStats({
        urlParams: { days: 7 },
      });

      expect(timeline).toHaveLength(7);
      const today = new Date().toISOString().slice(0, 10);
      expect(timeline[timeline.length - 1]!.date).toBe(today);
      // Ascending, one calendar day apart, with no gaps for quiet days.
      const dates = timeline.map((point) => point.date);
      expect([...dates].sort()).toEqual(dates as string[]);
      expect(new Set(dates).size).toBe(7);

      // The 12h-old post lands on today or yesterday depending on the wall
      // clock, so assert on the window's sum rather than a single bucket.
      const sum = (key: "posts" | "comments" | "messages" | "signups") =>
        timeline.reduce((total, point) => total + point[key], 0);
      expect(sum("posts")).toBe(1);
      expect(sum("comments")).toBe(1);
      expect(sum("messages")).toBe(0); // 10 days ago, outside a 7-day window
      expect(sum("signups")).toBe(3); // seed-fresh, seed-recent, the admin
    }),
  ));

test("getAdminStats defaults the timeline to 14 days and rejects an out-of-range days param", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAdmin("root", "s3cret-pw");
      const c = yield* makeAuthedClient(accessToken);

      const stats = yield* c.admin.getAdminStats({ urlParams: {} });
      expect(stats.timeline).toHaveLength(14);

      const single = yield* c.admin.getAdminStats({ urlParams: { days: 1 } });
      expect(single.timeline).toHaveLength(1);

      const max = yield* c.admin.getAdminStats({
        urlParams: { days: MAX_ADMIN_TIMELINE_DAYS },
      });
      expect(max.timeline).toHaveLength(MAX_ADMIN_TIMELINE_DAYS);

      const tooMany = yield* c.admin
        .getAdminStats({ urlParams: { days: MAX_ADMIN_TIMELINE_DAYS + 1 } })
        .pipe(Effect.either);
      expect(tooMany._tag).toBe("Left");

      const zero = yield* c.admin
        .getAdminStats({ urlParams: { days: 0 } })
        .pipe(Effect.either);
      expect(zero._tag).toBe("Left");
    }),
  ));

test("getAdminStats reports healthy dependencies and this process's runtime counters", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAdmin("root", "s3cret-pw");
      const c = yield* makeAuthedClient(accessToken);

      const { health } = yield* c.admin.getAdminStats({ urlParams: {} });

      expect(health.status).toBe("ok");
      expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(health.dependencies.map((d) => d.name).sort()).toEqual([
        "database",
        "pubsub",
      ]);
      for (const dependency of health.dependencies) {
        expect(dependency.reachable).toBe(true);
        expect(dependency.latencyMs).not.toBeNull();
        expect(dependency.latencyMs!).toBeGreaterThanOrEqual(0);
      }
      // The tests drive an in-process web handler, so the backends are the
      // embedded defaults rather than Postgres/Redis.
      expect(
        health.dependencies.find((d) => d.name === "database")!.backend,
      ).toBe(process.env.DATABASE_URL ? "postgres" : "pglite");
      expect(
        health.dependencies.find((d) => d.name === "pubsub")!.backend,
      ).toBe(process.env.REDIS_URL ? "redis" : "memory");

      // Process-wide registry shared with whichever other test files land in
      // the same `--parallel` worker, so these are bounds, not exact values
      // (same reasoning as users.test.ts's metric assertions).
      expect(health.requestsTotal).toBeGreaterThanOrEqual(0);
      expect(health.serverErrorsTotal).toBeGreaterThanOrEqual(0);
      expect(health.errorRate).toBeGreaterThanOrEqual(0);
      expect(health.errorRate).toBeLessThanOrEqual(1);
      expect(health.websocketConnections).toBeGreaterThanOrEqual(0);
    }),
  ));

test("getAdminStats reports an empty deployment as all zeroes rather than failing", () =>
  run(
    Effect.gen(function* () {
      const { accessToken } = yield* registerAdmin("root", "s3cret-pw");
      const c = yield* makeAuthedClient(accessToken);

      const stats = yield* c.admin.getAdminStats({ urlParams: {} });

      expect(stats.totals.posts).toBe(0);
      expect(stats.totals.messages).toBe(0);
      // `sum()` over zero rows is null in Postgres — coalesced to 0.
      expect(stats.totals.attachmentBytes).toBe(0);
      for (const entry of stats.activity) {
        expect(entry.activeUsers).toBe(0);
        expect(entry.newPosts).toBe(0);
      }
      for (const point of stats.timeline) {
        expect(point.posts).toBe(0);
        expect(point.comments).toBe(0);
        expect(point.messages).toBe(0);
      }
    }),
  ));
