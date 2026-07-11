import { afterAll, expect, test } from "bun:test";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { globalRateLimit } from "./GlobalRateLimit.ts";
import { InMemoryRateLimiterLive } from "./RateLimiter.ts";

// A trivial inner app: globalRateLimit only ever reads `.url`/`.remoteAddress`
// off the request, so a minimal stand-in is enough to exercise it without
// spinning up the full HttpApi/router machinery those fields would otherwise
// require (see Metrics.test.ts/Health.test.ts for that heavier harness).
const okApp = HttpServerResponse.text("ok");

// HttpServerRequest.url is host-stripped (path + query only — see
// ServerRequest.fromWeb's `removeHost`), not an absolute URL, so requests
// below use bare paths like "/health" to match production shape.
const requestLive = (path: string, remoteAddress: string) =>
  Layer.succeed(HttpServerRequest.HttpServerRequest, {
    url: path,
    remoteAddress: Option.some(remoteAddress),
  } as unknown as HttpServerRequest.HttpServerRequest);

// One shared limiter instance across every `request()` call in a test so its
// buckets actually accumulate across calls, the same way a single process's
// InMemoryRateLimiterLive does in production (see RateLimiter.ts).
const runtime = ManagedRuntime.make(InMemoryRateLimiterLive);
afterAll(() => runtime.dispose());

const request = (
  path: string,
  remoteAddress: string,
): Promise<HttpServerResponse.HttpServerResponse> =>
  runtime.runPromise(
    globalRateLimit(okApp).pipe(
      Effect.provide(requestLive(path, remoteAddress)),
    ),
  );

test("a request under the ceiling passes through untouched", async () => {
  const response = await request("/version", "1.1.1.1");
  expect(response.status).toBe(200);
});

test("the ceiling trips after GLOBAL_MAX_REQUESTS_PER_IP requests from the same IP, returning 429 with a Retry-After hint", async () => {
  // GLOBAL_MAX_REQUESTS_PER_IP is 300 (GlobalRateLimit.ts).
  for (let i = 0; i < 300; i++) {
    const response = await request("/version", "2.2.2.2");
    expect(response.status).toBe(200);
  }

  const tripped = await request("/version", "2.2.2.2");
  expect(tripped.status).toBe(429);
  const retryAfter = tripped.headers["retry-after"];
  expect(Number(retryAfter)).toBeGreaterThan(0);
});

test("a different source IP gets its own, independent bucket", async () => {
  // Trip the ceiling for one IP...
  for (let i = 0; i < 301; i++) {
    await request("/version", "3.3.3.3");
  }
  const trippedForFirstIp = await request("/version", "3.3.3.3");
  expect(trippedForFirstIp.status).toBe(429);

  // ...a fresh IP should be unaffected.
  const untouchedIp = await request("/version", "4.4.4.4");
  expect(untouchedIp.status).toBe(200);
});

test("/health, /ready, and /metrics are exempt from the ceiling and never consume its budget", async () => {
  const ip = "5.5.5.5";
  for (let i = 0; i < 301; i++) {
    const health = await request("/health", ip);
    expect(health.status).toBe(200);
    const ready = await request("/ready", ip);
    expect(ready.status).toBe(200);
    const metrics = await request("/metrics", ip);
    expect(metrics.status).toBe(200);
  }

  // Same IP's real-traffic bucket should be untouched by all of the above.
  const response = await request("/version", ip);
  expect(response.status).toBe(200);
});
