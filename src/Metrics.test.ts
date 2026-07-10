import { expect, test } from "bun:test";
import { FetchHttpClient, HttpApiBuilder, HttpClient } from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, Metric } from "effect";
import { ChatApi } from "./Api.ts";
import { AuthenticationLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { Db, type DrizzleDb } from "./Db.ts";
import { JwtLive } from "./Jwt.ts";
import {
  MetricsRouteLive,
  recordHttpMetrics,
  websocketConnectionsActive,
} from "./Metrics.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { InMemoryPresenceStoreLive } from "./Presence.ts";
import { InMemoryPubSubLive } from "./PubSub.ts";
import { InMemoryRateLimiterLive } from "./RateLimiter.ts";
import { RealtimeConnections, RealtimeConnectionsLive } from "./Realtime.ts";
import { RealtimeHandlerLive } from "./RealtimeHandler.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import { VersionHandlerLive } from "./VersionHandler.ts";
import { InMemoryWsTicketLive } from "./WsTicket.ts";

// JwtLive reads JWT_SECRET from config; provide a deterministic test secret.
process.env.JWT_SECRET ??= "test-secret";

// `/metrics` is a raw route attached to the same shared router as `ChatApi`
// (see Metrics.ts), so — same as Health.test.ts — an `HttpApi.Api` layer
// must be present for `HttpApiBuilder.toWebHandler` to build a handler at
// all, even though these tests never call any of its endpoints.
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

// Never actually queried by these tests (no endpoint under test touches the
// DB) — just enough to satisfy ApiLive's requirements.
const unusedDbLive = Layer.succeed(Db, {} as unknown as DrizzleDb);

const run = async <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> => {
  const ServerLive = Layer.mergeAll(ApiLive, MetricsRouteLive).pipe(
    Layer.provide(RealtimeConnectionsLive),
    Layer.provide(InMemoryPubSubLive),
    Layer.provide(InMemoryPresenceStoreLive),
    Layer.provide(unusedDbLive),
  );

  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(ServerLive, BunHttpServer.layerContext),
    { middleware: recordHttpMetrics },
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

test("GET /metrics returns Prometheus text exposition format", async () => {
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/metrics");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(
        "text/plain; version=0.0.4; charset=utf-8",
      );

      const body = yield* response.text;
      // Effect's built-in fiber metrics are always present once any fiber
      // has run, so the response is never empty even before this route sees
      // any application-defined metric activity.
      expect(body).toContain("# TYPE effect_fiber_started counter");
    }),
  );
});

test("recordHttpMetrics records a request against httpRequestsTotal, labeled by normalized route and status", async () => {
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      // /users/123 is unauthenticated-reachable-enough to exercise routing
      // (it 401s without a bearer token) — normalizeRoute should still
      // collapse the numeric id before it ever reaches a metric label.
      yield* client.get("http://localhost/users/123");

      const metricsResponse = yield* client.get("http://localhost/metrics");
      const body = yield* metricsResponse.text;
      expect(body).toContain(
        'http_requests_total{method="GET",route="/users/:id",status="401"}',
      );
    }),
  );
});

// websocketConnectionsActive backs a module-level `effect/Metric`, shared
// with whichever other test files land in the same `bun test --parallel`
// worker process — so this asserts the *delta* register/unregister produce,
// not an absolute value (which a sibling file's own register/unregister
// calls could easily have already nudged off zero).
test("RealtimeConnections.register/unregister track the websocketConnectionsActive gauge", async () => {
  const TestRealtimeLive = RealtimeConnectionsLive.pipe(
    Layer.provide(InMemoryPubSubLive),
    Layer.provide(InMemoryPresenceStoreLive),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const before = yield* Metric.value(websocketConnectionsActive);

      const unregister = yield* connections.register(1, () => Effect.void);
      const during = yield* Metric.value(websocketConnectionsActive);
      expect(during.value).toBe(before.value + 1);

      unregister();
      // The gauge decrement on disconnect is forked rather than awaited
      // (see Realtime.ts's `register` cleanup), so give it a tick to land.
      yield* Effect.sleep("10 millis");
      const after = yield* Metric.value(websocketConnectionsActive);
      expect(after.value).toBe(before.value);
    }).pipe(Effect.provide(TestRealtimeLive)),
  );
});
