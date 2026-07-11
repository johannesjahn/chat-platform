import { expect, test } from "bun:test";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { ConfigProvider, Effect, HashMap, Layer, Logger, Option } from "effect";
import { redactedLogger, redactUrl } from "./RedactedLogger.ts";

test("redactUrl masks credential query params but leaves the rest untouched", () => {
  expect(redactUrl("/ws?token=secret123")).toBe("/ws?token=REDACTED");
  expect(redactUrl("/api/posts?page=2")).toBe("/api/posts?page=2");
  expect(redactUrl("/ws")).toBe("/ws");
  expect(redactUrl("/login?password=hunter2&next=home")).toBe(
    "/login?password=REDACTED&next=home",
  );
});

// Regression test for #43: `/ws?token=` must never reach logs verbatim,
// regardless of which query param a future auth mechanism uses for it.
test("redactedLogger logs a redacted URL while the handler still sees the real one", async () => {
  const loggedUrls: string[] = [];
  const captureLogger = Logger.make(({ annotations }) => {
    const url = HashMap.get(annotations, "http.url");
    if (url._tag === "Some") loggedUrls.push(url.value as string);
  });

  const mockRequest = {
    url: "/ws?token=super-secret",
    method: "GET",
    remoteAddress: Option.none(),
    headers: {},
  } as unknown as HttpServerRequest.HttpServerRequest;

  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    expect(request.url).toBe("/ws?token=super-secret");
    return HttpServerResponse.text("ok");
  });

  await Effect.runPromise(
    redactedLogger(handler).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, mockRequest),
      Effect.provide(Logger.replace(Logger.defaultLogger, captureLogger)),
    ),
  );

  expect(loggedUrls).toEqual(["/ws?token=REDACTED"]);
});

test("redactedLogger appends a hashed representation of the resolved client IP", async () => {
  const loggedIpHashes: string[] = [];
  const captureLogger = Logger.make(({ annotations }) => {
    const hash = HashMap.get(annotations, "http.client_ip_hash");
    if (hash._tag === "Some") loggedIpHashes.push(hash.value as string);
  });

  const mockRequest = {
    url: "/api/test",
    method: "GET",
    remoteAddress: Option.some("1.2.3.4"),
    headers: {
      "x-forwarded-for": "9.9.9.9, 10.0.0.1",
    },
  } as unknown as HttpServerRequest.HttpServerRequest;

  const handler = Effect.succeed(HttpServerResponse.text("ok"));

  // Use ConfigProvider to mock TRUST_PROXY
  const testConfigProvider = ConfigProvider.fromMap(
    new Map([["TRUST_PROXY", "10.0.0.0/8"]]),
  );

  await Effect.runPromise(
    redactedLogger(handler).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, mockRequest),
      Effect.provide(Logger.replace(Logger.defaultLogger, captureLogger)),
      Effect.provide(Layer.setConfigProvider(testConfigProvider)),
    ),
  );

  expect(loggedIpHashes.length).toBe(1);
  const resolvedHash = loggedIpHashes[0];
  expect(resolvedHash).toBeDefined();
  expect(resolvedHash).not.toBe("unknown");
  expect(resolvedHash).not.toBe("1.2.3.4");
  expect(resolvedHash).not.toBe("9.9.9.9");
  expect(resolvedHash).toMatch(/^[0-9a-f]{16}$/); // 16-character hex
});
