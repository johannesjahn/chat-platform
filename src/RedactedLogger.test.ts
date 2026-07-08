import { expect, test } from "bun:test";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, HashMap, Logger } from "effect";
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
  } as HttpServerRequest.HttpServerRequest;

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
