import { expect, test } from "bun:test";
import { FetchHttpClient, HttpApiBuilder, HttpClient } from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { ChatApi } from "./Api.ts";
import { AuthenticationLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { HealthRouteLive, ReadyRouteLive } from "./Health.ts";
import { JwtLive } from "./Jwt.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { InMemoryPubSubLive, PubSub } from "./PubSub.ts";
import { InMemoryRateLimiterLive } from "./RateLimiter.ts";
import { RealtimeConnectionsLive } from "./Realtime.ts";
import { RealtimeHandlerLive } from "./RealtimeHandler.ts";
import { getTestDb, resetTestDb } from "./testDb.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import { VersionHandlerLive } from "./VersionHandler.ts";
import { InMemoryWsTicketLive } from "./WsTicket.ts";

// JwtLive reads JWT_SECRET from config; provide a deterministic test secret.
process.env.JWT_SECRET ??= "test-secret";

// /health and /ready are raw routes attached to the same shared router as
// `ChatApi` (see Health.ts), so — same as RealtimeSocket.test.ts — an
// `HttpApi.Api` layer must be present for `HttpApiBuilder.toWebHandler` to
// build a handler at all, even though these tests never call any of its
// endpoints.
const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(PostsHandlerLive),
  Layer.provide(ChatsHandlerLive),
  Layer.provide(VersionHandlerLive),
  Layer.provide(RealtimeHandlerLive),
  Layer.provide(InMemoryRateLimiterLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(JwtLive),
  Layer.provide(InMemoryWsTicketLive),
);

const migratedDbLive = Layer.effect(
  Db,
  Effect.promise(async () => {
    const db = await getTestDb();
    await resetTestDb(db);
    return db;
  }),
);

// A Db layer whose `execute` always rejects, standing in for a DB that's up
// at the TCP level but not actually queryable — the case /ready exists to
// catch.
const brokenDbLive = Layer.succeed(Db, {
  execute: () => Promise.reject(new Error("db unreachable")),
} as unknown as DrizzleDb);

const brokenPubSubLive = Layer.succeed(PubSub, {
  publish: () => Effect.void,
  subscribe: () => Effect.void,
  ping: Effect.fail(new Error("redis unreachable")),
});

const run = async <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  dbLive: Layer.Layer<Db>,
  pubSubLive: Layer.Layer<PubSub> = InMemoryPubSubLive,
): Promise<A> => {
  const ServerLive = Layer.mergeAll(
    ApiLive,
    HealthRouteLive,
    ReadyRouteLive,
  ).pipe(
    Layer.provide(RealtimeConnectionsLive),
    Layer.provide(pubSubLive),
    Layer.provide(dbLive),
  );

  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(ServerLive, BunHttpServer.layerContext),
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
      effect.pipe(Effect.provide(TestClientLayer)),
    );
  } finally {
    await dispose();
  }
};

test("GET /health always reports ok, with no dependency checks", async () => {
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/health");
      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("ok");
    }),
    brokenDbLive,
  );
});

test("GET /ready reports ok once the DB and PubSub are reachable", async () => {
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/ready");
      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("ok");
    }),
    migratedDbLive,
  );
});

test("GET /ready reports 503 when the DB is unreachable", async () => {
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/ready");
      expect(response.status).toBe(503);
    }),
    brokenDbLive,
  );
});

test("GET /ready reports 503 when PubSub is unreachable", async () => {
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/ready");
      expect(response.status).toBe(503);
    }),
    migratedDbLive,
    brokenPubSubLive,
  );
});
