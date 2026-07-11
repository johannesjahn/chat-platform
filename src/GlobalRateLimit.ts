import {
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
  type HttpApp,
} from "@effect/platform";
import { Effect } from "effect";
import { clientIp } from "./ClientIp.ts";
import { RateLimiter } from "./RateLimiter.ts";

// Global per-IP request-rate ceiling (issue #40, sub-task of #25) — a single
// coarse limit applied across the whole API as defense-in-depth against
// request floods, independent of and much looser than the per-endpoint
// limits on auth routes (see UsersHandler.ts). Those exist to stop
// brute-forcing/spam on specific endpoints; this exists purely to blunt a
// flood hitting the API from one source, and shouldn't otherwise be
// noticeable during normal use. Deliberately generous (~17 requests/sec
// sustained) — many legitimate clients share one IP (NAT, a corporate
// proxy, this repo's own e2e suite running several browser sessions
// against one local backend), and this ceiling only needs to catch actual
// floods, not ordinary concurrent bursts.
const GLOBAL_MAX_REQUESTS_PER_IP = 1000;
const GLOBAL_WINDOW_SECONDS = 60;

// Raw orchestrator/scraper routes (see Health.ts/Metrics.ts) are exempt: a
// pod polls these on a fixed schedule for the app's whole lifetime, often
// from a small set of infra IPs shared with other traffic (e.g. behind a
// NAT gateway or load balancer) — counting those hits against the same
// bucket as everything else would let unrelated API load trip the ceiling
// and fail the very checks that keep the pod alive, the opposite of what a
// defense-in-depth measure should do.
const EXEMPT_PATHS = new Set(["/health", "/ready", "/metrics"]);

const pathnameOf = (url: string): string => {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
};

export const globalRateLimit = HttpMiddleware.make(
  <E, R>(httpApp: HttpApp.Default<E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (EXEMPT_PATHS.has(pathnameOf(request.url))) return yield* httpApp;

      const limiter = yield* RateLimiter;
      const ip = yield* clientIp;
      const result = yield* limiter.consume(
        `global:${ip}`,
        GLOBAL_MAX_REQUESTS_PER_IP,
        GLOBAL_WINDOW_SECONDS,
      );
      if (!result.allowed) {
        return yield* HttpServerResponse.text("Too Many Requests", {
          status: 429,
          headers: { "retry-after": String(result.retryAfterSeconds) },
        });
      }
      return yield* httpApp;
    }),
);
