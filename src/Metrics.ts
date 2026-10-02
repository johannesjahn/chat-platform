import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { PrometheusMetrics } from "effect/observability";
import { Cause, Effect, Layer, Metric } from "effect";
import { withLoggerDisabled } from "./RedactedLogger.ts";

// Application-level metrics for VictoriaMetrics/vmagent to scrape (issue
// #124, sub-task of #121) — a Prometheus-format `/metrics` route, same "raw
// route, not part of the typed `ChatApi`" pattern as `/health`/`/ready` (see
// Health.ts). Built on `effect/Metric` (counters/gauges/histograms) plus a
// effect's own Prometheus exposition-format renderer
// (`effect/observability/PrometheusMetrics`), rather than pulling in
// `prom-client` — Effect's metric registry already gives us everything a
// Node-oriented client library would, without a dependency this Bun-first
// repo (see CLAUDE.md) doesn't otherwise need.

export const httpRequestsTotal = Metric.counter("http_requests_total", {
  description: "Total HTTP requests handled.",
});

// Seconds (Prometheus convention), exponential from 5ms up to ~40s;
// Metric.exponentialBoundaries appends a final +Inf bucket automatically.
export const httpRequestDurationSeconds = Metric.histogram(
  "http_request_duration_seconds",
  {
    description: "HTTP request duration in seconds.",
    boundaries: Metric.exponentialBoundaries({
      start: 0.005,
      factor: 2,
      count: 14,
    }),
  },
);

// A metric only shows up in the registry (and so in `/metrics`) once
// something has touched it; reading it is enough. See the two eagerly
// registered metrics below for why that matters.
const register = <M extends Metric.Metric<never, unknown>>(metric: M): M => {
  Effect.runSync(Metric.value(metric));
  return metric;
};

// `register`ed eagerly (unlike the metrics below, which are always
// accessed through `Metric.withAttributes` and so only ever get
// created lazily, on demand, with whatever tags that call used) — this one
// is never tagged, so registering it up front means `/metrics` reports an
// honest `0` from process start rather than omitting the series entirely
// until the first `/ws` connection (a missing series and a `0` mean very
// different things to a scrape-gap alert).
export const websocketConnectionsActive = register(
  Metric.gauge("websocket_connections_active", {
    description: "Live /ws connections currently held open by this instance.",
  }),
);

// See recordHttpMetrics below for why this counts request-level defects
// rather than instrumenting every `db.*` call site individually. Eagerly
// `register`ed for the same reason as websocketConnectionsActive above.
export const dbQueryErrorsTotal = register(
  Metric.counter("db_query_errors_total", {
    description: "DB failures observed while handling HTTP requests.",
  }),
);

export const pubsubPublishTotal = Metric.counter("pubsub_publish_total", {
  description: "PubSub publish attempts, labeled by outcome.",
});

export const pubsubSubscribeTotal = Metric.counter("pubsub_subscribe_total", {
  description: "PubSub subscribe attempts, labeled by outcome.",
});

// Application-domain activity metrics (issue #196, follow-up to #124's
// transport-level ones) — every metric below is a count or a distribution
// with no user id, username, IP, or IP hash ever used as a label or
// persisted value (see the issue's GDPR-driven scoping discussion for why
// that constraint exists and what it rules out, e.g. a "most active users"
// panel).

// Labeled only by content `type` ("post"/"comment"/"reaction"/"message") —
// same cardinality profile as pubsubPublishTotal above, never by
// author/post/chat id.
export const contentCreatedTotal = Metric.counter("content_created_total", {
  description: "Content items created, labeled by type.",
});

// Set (not incremented) by ActiveUsersMetrics.ts's periodic
// `COUNT(DISTINCT user_id)` job, one gauge per `window` label
// ("1d"/"7d"/"30d") — DAU/WAU/MAU. The distinct-user computation happens
// inside that job's SQL query; only the resulting count ever reaches this
// gauge.
export const activeUsers = Metric.gauge("active_users", {
  description:
    "Distinct users who created content in the trailing window (DAU/WAU/MAU).",
});

// Labeled by `event` ("connect"/"disconnect") — the churn counterpart to
// websocketConnectionsActive's point-in-time gauge above, which only shows
// the current count, not the rate connections come and go.
export const websocketConnectionsTotal = Metric.counter(
  "websocket_connections_total",
  { description: "WebSocket connection lifecycle events, labeled by event." },
);

// Labeled by `limiter` (e.g. "global"/"register"/"login"/"refresh"/
// "change-password"/"engagement" — the bucket *kind*, not which specific IP
// or account tripped it: see enforceRateLimit in UsersHandler.ts, which
// derives this from the part of its rate-limit key before the first ":").
// A 429 would otherwise be invisible in httpRequestsTotal, indistinguishable
// from any other status.
export const rateLimitRejectionsTotal = Metric.counter(
  "rate_limit_rejections_total",
  { description: "Requests rejected by a rate limiter, labeled by limiter." },
);

// Labeled by `event` ("signup"/"login"/"refresh") and `outcome`
// ("success"/"failure") — an auth funnel, never by username/user id.
// Rate-limit rejections on these same endpoints are counted separately via
// rateLimitRejectionsTotal rather than as a "failure" here, so the two don't
// double-count the same rejected request.
export const authEventsTotal = Metric.counter("auth_events_total", {
  description: "Authentication funnel events, labeled by event and outcome.",
});

const pathnameOf = (url: string): string => {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
};

// Every dynamic path segment in `ChatApi` is a numeric id (see Api.ts's
// `Schema.Int` path schemas — chat/message/user ids). Collapsing runs
// of digits keeps the "route" label's cardinality bounded to the handful of
// route templates rather than growing with every distinct id ever
// requested — the standard pitfall of labeling HTTP metrics by raw path.
const normalizeRoute = (pathname: string): string =>
  pathname.replace(/\/\d+(?=\/|$)/g, "/:id");

const isRouteNotFound = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      HttpServerError.isHttpServerError(reason.error) &&
      reason.error.reason._tag === "RouteNotFound",
  );

// Wraps the whole server (same attachment point as RedactedLogger.ts's
// `redactedLogger`) to record HTTP request count + duration, labeled by
// method/route/status — the "HTTP request count/duration histogram" entry
// from issue #124. A request that never matched any route at all (bots
// probing for `/wp-admin`, scanners, ...) collapses its route label to a
// fixed "unmatched" instead of the raw path, so a scan can't blow up this
// metric's cardinality the way echoing arbitrary 404 paths would.
export const recordHttpMetrics = <E, R>(
  httpApp: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  >,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const start = performance.now();
    const exit = yield* Effect.exit(httpApp);

    const durationSeconds = (performance.now() - start) / 1000;
    const status =
      exit._tag === "Success"
        ? exit.value.status
        : HttpServerError.causeResponseStripped(exit.cause)[0].status;
    const route =
      exit._tag === "Failure" && isRouteNotFound(exit.cause)
        ? "unmatched"
        : normalizeRoute(pathnameOf(request.url));
    const attributes = {
      method: request.method,
      route,
      status: String(status),
    };

    yield* Metric.update(
      Metric.withAttributes(httpRequestsTotal, attributes),
      1,
    );
    yield* Metric.update(
      Metric.withAttributes(httpRequestDurationSeconds, attributes),
      durationSeconds,
    );
    if (exit._tag === "Failure" && Cause.hasDies(exit.cause))
      yield* Metric.update(dbQueryErrorsTotal, 1);

    return yield* exit;
  });

// Renders every metric captured via `effect/Metric` (the definitions above,
// plus any of Effect's own built-in runtime metrics, when enabled) in
// Prometheus text exposition format.
export const renderPrometheusExposition: Effect.Effect<string> =
  PrometheusMetrics.format();

// Raw route (not part of the typed `ChatApi`) — see Health.ts's header
// comment for why: scraper-only, so it's excluded from openapi.json and the
// generated frontend client. Unauthenticated like `/health`/`/ready` —
// vmagent scrapes this directly and can't present a bearer token — and logs
// disabled for the same reason those two do (a scraper polls this on its
// own short interval for the app's whole lifetime). Also exempt from the
// global rate-limit ceiling (see GlobalRateLimit.ts), which hardcodes this
// path for the same reason.
export const MetricsRouteLive: Layer.Layer<
  never,
  never,
  HttpRouter.HttpRouter
> = HttpRouter.add(
  "GET",
  "/metrics",
  withLoggerDisabled(
    Effect.map(renderPrometheusExposition, (body) =>
      HttpServerResponse.text(body, {
        contentType: "text/plain; version=0.0.4; charset=utf-8",
      }),
    ),
  ),
);
