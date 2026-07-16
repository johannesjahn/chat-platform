import {
  HttpApiBuilder,
  HttpMiddleware,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  type HttpApp,
} from "@effect/platform";
import {
  Cause,
  Context,
  Effect,
  Metric,
  MetricBoundaries,
  MetricLabel,
  MetricPair,
  MetricState,
  Option,
} from "effect";

// Application-level metrics for VictoriaMetrics/vmagent to scrape (issue
// #124, sub-task of #121) — a Prometheus-format `/metrics` route, same "raw
// route, not part of the typed `ChatApi`" pattern as `/health`/`/ready` (see
// Health.ts). Built on `effect/Metric` (counters/gauges/histograms) plus a
// small hand-rolled exposition-format renderer below, rather than pulling in
// `prom-client` — Effect's metric registry already gives us everything a
// Node-oriented client library would, without a dependency this Bun-first
// repo (see CLAUDE.md) doesn't otherwise need.

export const httpRequestsTotal = Metric.counter("http_requests_total", {
  description: "Total HTTP requests handled.",
});

// Seconds (Prometheus convention), exponential from 5ms up to ~40s;
// MetricBoundaries.exponential appends a final +Inf bucket automatically.
export const httpRequestDurationSeconds = Metric.histogram(
  "http_request_duration_seconds",
  MetricBoundaries.exponential({ start: 0.005, factor: 2, count: 14 }),
  "HTTP request duration in seconds.",
);

// `.register()`d eagerly (unlike the metrics below, which are always
// accessed through `Metric.tagged`/`taggedWithLabels` and so only ever get
// created lazily, on demand, with whatever tags that call used) — this one
// is never tagged, so registering it up front means `/metrics` reports an
// honest `0` from process start rather than omitting the series entirely
// until the first `/ws` connection (a missing series and a `0` mean very
// different things to a scrape-gap alert).
export const websocketConnectionsActive = Metric.gauge(
  "websocket_connections_active",
  { description: "Live /ws connections currently held open by this instance." },
).register();

// See recordHttpMetrics below for why this counts request-level defects
// rather than instrumenting every `db.*` call site individually. Eagerly
// `.register()`d for the same reason as websocketConnectionsActive above.
export const dbQueryErrorsTotal = Metric.counter("db_query_errors_total", {
  description: "DB failures observed while handling HTTP requests.",
}).register();

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

// Labeled only by content `type` ("post"/"comment"/"like"/"message") — same
// cardinality profile as pubsubPublishTotal above, never by author/post/chat
// id.
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
// `NumberFromString` path schemas — chat/message/user ids). Collapsing runs
// of digits keeps the "route" label's cardinality bounded to the handful of
// route templates rather than growing with every distinct id ever
// requested — the standard pitfall of labeling HTTP metrics by raw path.
const normalizeRoute = (pathname: string): string =>
  pathname.replace(/\/\d+(?=\/|$)/g, "/:id");

const isRouteNotFound = (failure: Option.Option<unknown>): boolean =>
  Option.isSome(failure) &&
  typeof failure.value === "object" &&
  failure.value !== null &&
  (failure.value as { _tag?: unknown })._tag === "RouteNotFound";

// Wraps the whole server (same attachment point as RedactedLogger.ts's
// `redactedLogger`) to record HTTP request count + duration, labeled by
// method/route/status — the "HTTP request count/duration histogram" entry
// from issue #124. A request that never matched any route at all (bots
// probing for `/wp-admin`, scanners, ...) collapses its route label to a
// fixed "unmatched" instead of the raw path, so a scan can't blow up this
// metric's cardinality the way echoing arbitrary 404 paths would.
export const recordHttpMetrics = HttpMiddleware.make(
  <E, R>(httpApp: HttpApp.Default<E, R>): HttpApp.Default<E, R> =>
    Effect.withFiberRuntime((fiber) => {
      const request = Context.unsafeGet(
        fiber.currentContext,
        HttpServerRequest.HttpServerRequest,
      );
      const start = performance.now();

      return Effect.flatMap(Effect.exit(httpApp), (exit) => {
        const durationSeconds = (performance.now() - start) / 1000;
        const status =
          exit._tag === "Success"
            ? exit.value.status
            : HttpServerError.causeResponseStripped(exit.cause)[0].status;
        const route =
          exit._tag === "Failure" &&
          isRouteNotFound(Cause.failureOption(exit.cause))
            ? "unmatched"
            : normalizeRoute(pathnameOf(request.url));
        const tags = [
          MetricLabel.make("method", request.method),
          MetricLabel.make("route", route),
          MetricLabel.make("status", String(status)),
        ];

        return Effect.zipRight(
          Effect.all(
            [
              Metric.update(
                Metric.taggedWithLabels(httpRequestsTotal, tags),
                1,
              ),
              Metric.update(
                Metric.taggedWithLabels(httpRequestDurationSeconds, tags),
                durationSeconds,
              ),
              exit._tag === "Failure" && Cause.isDie(exit.cause)
                ? Metric.increment(dbQueryErrorsTotal)
                : Effect.void,
            ],
            { discard: true },
          ),
          exit,
        );
      });
    }),
);

const escapeLabelValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const formatLabels = (
  labels: ReadonlyArray<readonly [string, string]>,
): string =>
  labels.length === 0
    ? ""
    : `{${labels.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;

const formatSample = (
  name: string,
  labels: ReadonlyArray<readonly [string, string]>,
  value: number | bigint,
): string => `${name}${formatLabels(labels)} ${value}\n`;

// Renders every metric captured via `effect/Metric` (the definitions above,
// plus Effect's own built-in fiber metrics — fiberStarted/fiberSuccesses/
// fiberFailures/fiberLifetimes) in Prometheus text exposition format.
export const renderPrometheusExposition: Effect.Effect<string> = Effect.map(
  Metric.snapshot,
  (pairs) => {
    // Prometheus wants one HELP/TYPE header per metric *name*, followed by
    // every tagged sample for it — but each distinct tag combination is its
    // own MetricPair in the snapshot, so group by name first.
    const byName = new Map<string, Array<MetricPair.MetricPair.Untyped>>();
    for (const pair of pairs) {
      const group = byName.get(pair.metricKey.name) ?? [];
      group.push(pair);
      byName.set(pair.metricKey.name, group);
    }

    let output = "";
    for (const [name, group] of byName) {
      const [first] = group;
      if (!first) continue;

      const description = Option.getOrUndefined(first.metricKey.description);
      if (description) output += `# HELP ${name} ${description}\n`;

      if (MetricState.isCounterState(first.metricState)) {
        output += `# TYPE ${name} counter\n`;
        for (const pair of group) {
          if (!MetricState.isCounterState(pair.metricState)) continue;
          output += formatSample(
            name,
            pair.metricKey.tags.map((tag) => [tag.key, tag.value] as const),
            pair.metricState.count,
          );
        }
      } else if (MetricState.isGaugeState(first.metricState)) {
        output += `# TYPE ${name} gauge\n`;
        for (const pair of group) {
          if (!MetricState.isGaugeState(pair.metricState)) continue;
          output += formatSample(
            name,
            pair.metricKey.tags.map((tag) => [tag.key, tag.value] as const),
            pair.metricState.value,
          );
        }
      } else if (MetricState.isHistogramState(first.metricState)) {
        output += `# TYPE ${name} histogram\n`;
        for (const pair of group) {
          if (!MetricState.isHistogramState(pair.metricState)) continue;
          const baseLabels = pair.metricKey.tags.map(
            (tag) => [tag.key, tag.value] as const,
          );
          for (const [boundary, cumulativeCount] of pair.metricState.buckets) {
            output += formatSample(
              `${name}_bucket`,
              [
                ...baseLabels,
                ["le", boundary === Infinity ? "+Inf" : String(boundary)],
              ],
              cumulativeCount,
            );
          }
          output += formatSample(
            `${name}_sum`,
            baseLabels,
            pair.metricState.sum,
          );
          output += formatSample(
            `${name}_count`,
            baseLabels,
            pair.metricState.count,
          );
        }
      }
      // Frequency/Summary metrics aren't used by this app (see the
      // definitions above), so they're intentionally left unrendered rather
      // than guessing at an exposition-format mapping nothing exercises.
    }
    return output;
  },
);

// Raw route (not part of the typed `ChatApi`) — see Health.ts's header
// comment for why: scraper-only, so it's excluded from openapi.json and the
// generated frontend client. Unauthenticated like `/health`/`/ready` —
// vmagent scrapes this directly and can't present a bearer token — and logs
// disabled for the same reason those two do (a scraper polls this on its
// own short interval for the app's whole lifetime). Also exempt from the
// global rate-limit ceiling (see GlobalRateLimit.ts), which hardcodes this
// path for the same reason.
export const MetricsRouteLive = HttpApiBuilder.Router.use((router) =>
  router.get(
    "/metrics",
    HttpMiddleware.withLoggerDisabled(
      Effect.map(renderPrometheusExposition, (body) =>
        HttpServerResponse.text(body, {
          contentType: "text/plain; version=0.0.4; charset=utf-8",
        }),
      ),
    ),
  ),
);
