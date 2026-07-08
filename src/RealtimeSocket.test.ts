import { expect, test } from "bun:test";
import { FetchHttpClient, HttpApiBuilder, HttpClient } from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
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
import { RealtimeSocketRouteLive } from "./RealtimeSocket.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import { VersionHandlerLive } from "./VersionHandler.ts";
import * as schema from "./db/schema.ts";

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
  Layer.provide(InMemoryRateLimiterLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(JwtLive),
);

const ServerLive = Layer.mergeAll(ApiLive, RealtimeSocketRouteLive).pipe(
  Layer.provide(RealtimeConnectionsLive),
  Layer.provide(InMemoryPubSubLive),
  Layer.provide(JwtLive),
);

const run = async <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
): Promise<A> => {
  const db = drizzle({ schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
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
    await db.$client.close();
  }
};

test("GET /ws with no token is rejected before any upgrade is attempted", async () => {
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/ws");
      expect(response.status).toBe(401);
    }),
  );
});

test("GET /ws with a garbage token is rejected", async () => {
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(
        "http://localhost/ws?token=not-a-real-jwt",
      );
      expect(response.status).toBe(401);
    }),
  );
});

test("GET /ws with an expired-looking token is rejected the same as a missing one", async () => {
  // A syntactically-plausible but unsigned/garbage JWT should fail signature
  // verification exactly like a fully-invalid string — this guards against a
  // regression where malformed-but-3-part tokens slip past `verifyHs256`.
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.not-a-real-signature";
      const response = yield* client.get(
        `http://localhost/ws?token=${fakeJwt}`,
      );
      expect(response.status).toBe(401);
    }),
  );
});
