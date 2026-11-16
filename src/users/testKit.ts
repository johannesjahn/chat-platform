import { expect } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect, Layer, Metric } from "effect";
import { ChatApi } from "../Api.ts";
import { authEventsTotal } from "../Metrics.ts";
import { InMemoryPresenceStoreLive } from "../Presence.ts";
import { staticPresenceAudience } from "../PresenceAudience.ts";
import { PubSub } from "../PubSub.ts";
import { UserLocator } from "../UserLocator.ts";
import { RealtimeConnections, RealtimeConnectionsLive } from "../Realtime.ts";

// Helpers shared by the users test files (src/users/*.test.ts, split from
// users.test.ts by area). Each test file still calls `makeTestRun()` itself:
// it registers that file's own database hooks.

export const makeClient = HttpApiClient.make(ChatApi, {
  baseUrl: "http://localhost",
});

// authEventsTotal/rateLimitRejectionsTotal are module-level metrics shared
// with whichever other test files land in the same `bun test --parallel`
// worker process, so the tests assert deltas rather than absolute values
// (see Metrics.test.ts's websocketConnectionsActive test for the same
// reasoning).
export const authEventCount = (
  event: "signup" | "login" | "refresh",
  outcome: "success" | "failure",
) =>
  Metric.value(
    Metric.withAttributes(authEventsTotal, { event: event, outcome: outcome }),
  ).pipe(Effect.map((state) => state.count));

// A client that sends `Authorization: Bearer <token>` on every request, for
// exercising endpoints behind the Authentication middleware.
export const makeAuthedClient = (token: string) =>
  HttpApiClient.make(ChatApi, {
    baseUrl: "http://localhost",
    transformClient: (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
      ),
  });

export const decodeClaims = (token: string) => {
  const parts = token.split(".");
  expect(parts).toHaveLength(3);
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  expect(header).toEqual({ alg: "HS256", typ: "JWT" });
  return claims as {
    sub: number;
    username: string;
    role: string;
    type: string;
    iat: number;
    exp: number;
    tokenVersion: number;
  };
};

// Registers a stand-in `/ws` connection for `userId` and reports how many
// times it was closed — the users handlers must close a user's sockets
// wherever they bump token_version (issue #651). The connection lives on its
// own RealtimeConnectionsLive sharing the run's PubSub, i.e. on another
// replica than the one handling the request.
export const openSocket = (userId: number) =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub;
    const locator = yield* UserLocator;
    const connections = yield* Effect.service(RealtimeConnections).pipe(
      Effect.provide(
        RealtimeConnectionsLive.pipe(
          Layer.provide(Layer.succeed(PubSub, pubsub)),
          Layer.provide(Layer.succeed(UserLocator, locator)),
          Layer.provide(InMemoryPresenceStoreLive),
          Layer.provide(staticPresenceAudience([])),
        ),
      ),
    );
    const state = { closed: 0 };
    yield* connections.register(
      userId,
      () => Effect.void,
      () =>
        Effect.sync(() => {
          state.closed++;
        }),
    );
    return state;
  });
