import { expect, test } from "bun:test";
import { HttpClient } from "effect/http";
import { Effect, Layer, Metric } from "effect";
import { Db, type DrizzleDb } from "./Db.ts";
import {
  MetricsRouteLive,
  recordHttpMetrics,
  websocketConnectionsActive,
  websocketConnectionsTotal,
} from "./Metrics.ts";
import { InMemoryPresenceStoreLive } from "./Presence.ts";
import { InMemoryPubSubLive } from "./PubSub.ts";
import { RealtimeConnections, RealtimeConnectionsLive } from "./Realtime.ts";
import { makeTestRun } from "./testApi.ts";

// `/metrics` is a raw route attached to the same shared router as `ChatApi`
// (see Metrics.ts), served here through the shared test harness with the
// same recordHttpMetrics middleware main.ts wraps the server in. Never
// touches the DB, so the test database stays unbooted.
const run = makeTestRun({
  routes: MetricsRouteLive,
  db: Layer.succeed(Db, {} as unknown as DrizzleDb),
  middleware: recordHttpMetrics,
});

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
      // websocketConnectionsActive is registered eagerly (see Metrics.ts),
      // so the response is never empty even before this route sees any
      // other application-defined metric activity.
      expect(body).toContain("# TYPE websocket_connections_active gauge");
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

test("RealtimeConnections.register/unregister increment websocket_connections_total, labeled by event", async () => {
  const TestRealtimeLive = RealtimeConnectionsLive.pipe(
    Layer.provide(InMemoryPubSubLive),
    Layer.provide(InMemoryPresenceStoreLive),
  );
  const connects = Metric.withAttributes(websocketConnectionsTotal, {
    event: "connect",
  });
  const disconnects = Metric.withAttributes(websocketConnectionsTotal, {
    event: "disconnect",
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const connections = yield* RealtimeConnections;
      const beforeConnect = yield* Metric.value(connects);
      const beforeDisconnect = yield* Metric.value(disconnects);

      const unregister = yield* connections.register(1, () => Effect.void);
      expect((yield* Metric.value(connects)).count).toBe(
        beforeConnect.count + 1,
      );

      unregister();
      // The disconnect counter update is forked rather than awaited (same
      // reasoning as the gauge decrement above), so give it a tick to land.
      yield* Effect.sleep("10 millis");
      expect((yield* Metric.value(disconnects)).count).toBe(
        beforeDisconnect.count + 1,
      );
    }).pipe(Effect.provide(TestRealtimeLive)),
  );
});
