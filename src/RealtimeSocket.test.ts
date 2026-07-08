import { expect, test } from "bun:test";
import { FetchHttpClient, HttpApiBuilder, HttpClient } from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { ChatApi } from "./Api.ts";
import { AuthenticationLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { Db } from "./Db.ts";
import { JwtLive } from "./Jwt.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { InMemoryPubSubLive } from "./PubSub.ts";
import { InMemoryRateLimiterLive } from "./RateLimiter.ts";
import { RealtimeConnectionsLive } from "./Realtime.ts";
import { RealtimeHandlerLive } from "./RealtimeHandler.ts";
import { RealtimeSocketRouteLive } from "./RealtimeSocket.ts";
import { getTestDb, resetTestDb } from "./testDb.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import { VersionHandlerLive } from "./VersionHandler.ts";
import { InMemoryWsTicketLive } from "./WsTicket.ts";

// JwtLive reads JWT_SECRET from config; provide a deterministic test secret.
process.env.JWT_SECRET ??= "test-secret";

// These only exercise the pre-upgrade auth checks in RealtimeSocket.ts (the
// paths that return a plain 401 without ever calling
// `HttpServerRequest.upgrade`). The actual WebSocket upgrade needs a real
// `Bun.serve()` request behind it — `HttpApiBuilder.toWebHandler`'s fake
// fetch handler used here doesn't provide one — so the full connect/push
// behavior is covered by a real-server test instead (see
// RealtimeSocket.integration.test.ts).
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

const ServerLive = Layer.mergeAll(ApiLive, RealtimeSocketRouteLive).pipe(
  Layer.provide(RealtimeConnectionsLive),
  Layer.provide(InMemoryPubSubLive),
  Layer.provide(JwtLive),
  Layer.provide(InMemoryWsTicketLive),
);

const run = async <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> => {
  const db = await getTestDb();
  await resetTestDb(db);
  const TestDbLive = Layer.succeed(Db, db);

  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    Layer.mergeAll(
      ServerLive.pipe(Layer.provide(TestDbLive)),
      BunHttpServer.layerContext,
    ),
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

test("GET /ws with no ticket is rejected before any upgrade is attempted", async () => {
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/ws");
      expect(response.status).toBe(401);
    }),
  );
});

test("GET /ws with an unknown ticket is rejected", async () => {
  // A ticket that was never issued (or was already consumed — see
  // WsTicket.test.ts for single-use semantics) fails the same as no ticket
  // at all.
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(
        "http://localhost/ws?ticket=not-a-real-ticket",
      );
      expect(response.status).toBe(401);
    }),
  );
});

test("GET /ws from a disallowed Origin is rejected before the ticket is even checked", async () => {
  // Even with no ticket at all, a request from an origin outside the
  // WEB_ORIGIN allowlist should fail with 403 (Origin check), not the 401 a
  // same-origin/no-Origin request with no ticket would get.
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/ws", {
        headers: { origin: "https://evil.example" },
      });
      expect(response.status).toBe(403);
    }),
  );
});
