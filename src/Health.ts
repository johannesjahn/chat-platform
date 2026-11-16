import { HttpRouter, HttpServerResponse } from "effect/http";
import { Effect } from "effect";
import { Db } from "./Db.ts";
import { withLoggerDisabled } from "./RedactedLogger.ts";

// Raw routes (not part of the typed `ChatApi`) — orchestrators (compose
// `depends_on`, k8s probes, load balancers) poll these, they aren't part of
// the app's public surface, so there's no reason to carry them through
// OpenApi.fromApi/the generated frontend client. Both routes disable the
// access logger (see RedactedLogger.ts) — a pod polls these every few
// seconds for its whole lifetime, and logging each hit just drowns real
// request logs in noise without carrying any signal of its own. Both are
// also exempt from the global rate-limit ceiling (see GlobalRateLimit.ts),
// which hardcodes these paths for the same reason.

// Liveness: the process is up and can handle an HTTP request at all. No
// dependency checks on purpose — this only answers "should the orchestrator
// restart the container?", which a stuck DB/Redis connection doesn't imply
// on its own (that's what /ready, below, is for).
export const HealthRouteLive = HttpRouter.add(
  "GET",
  "/health",
  withLoggerDisabled(Effect.succeed(HttpServerResponse.text("ok"))),
);

// Readiness: the process has finished booting (DbLive's migrations, see
// Db.ts) and can currently reach the database. A process that's up but has
// lost it looks healthy at the TCP level and would otherwise keep receiving
// traffic.
//
// Redis is deliberately *not* checked (issue #832). The app serves without
// it — rate limits, `/ws` tickets, presence and realtime fall back to each
// instance's own state (see redisConnection.ts) — and an outage hits every
// pod at once, so failing readiness on it would take them all out of
// rotation: a degraded service becomes no service. `redis_connection_up`
// and the admin dashboard's dependency health show the outage instead.
export const ReadyRouteLive = HttpRouter.add(
  "GET",
  "/ready",
  Effect.gen(function* () {
    const db = yield* Db;
    const check = yield* Effect.tryPromise(() => db.execute("select 1")).pipe(
      Effect.result,
    );

    return check._tag === "Success"
      ? HttpServerResponse.text("ok")
      : HttpServerResponse.text("not ready", { status: 503 });
  }).pipe(withLoggerDisabled),
);
