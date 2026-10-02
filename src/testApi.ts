import { BunHttpServer } from "@effect/platform-bun";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Effect, Layer } from "effect";
import { AdminHandlerLive } from "./AdminHandler.ts";
import { ChatApi } from "./Api.ts";
import { AttachmentsHandlerLive } from "./AttachmentsHandler.ts";
import { AttachmentStorageLive } from "./AttachmentStorage.ts";
import { AuthenticationLive, TokenVersionCacheLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { Db } from "./Db.ts";
import { SanitizeDecodeErrorsLive } from "./DecodeErrorSanitizer.ts";
import { EngagementHandlerLive } from "./EngagementHandler.ts";
import { GamesHandlerLive } from "./GamesHandler.ts";
import { JwtLive } from "./Jwt.ts";
import { NotificationsHandlerLive } from "./NotificationsHandler.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { InMemoryPresenceStoreLive } from "./Presence.ts";
import { InMemoryPubSubLive, PubSub } from "./PubSub.ts";
import { InMemoryRateLimiterLive } from "./RateLimiter.ts";
import { RealtimeConnectionsLive } from "./Realtime.ts";
import { RealtimeHandlerLive } from "./RealtimeHandler.ts";
import { SearchHandlerLive } from "./SearchHandler.ts";
import { makeTestDbAccessor, resetTestDb } from "./testDb.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import { VersionHandlerLive } from "./VersionHandler.ts";
import { InMemoryWsTicketLive } from "./WsTicket.ts";

// The shared in-process harness for tests that drive `ChatApi` over HTTP:
// the whole API, wired the way main.ts wires it but with in-memory
// services, served through a web handler that a `FetchHttpClient` talks to
// directly — no server, no network.

// JwtLive reads JWT_SECRET from config; provide a deterministic test secret.
process.env.JWT_SECRET ??= "test-secret";

const ApiLive = HttpApiBuilder.layer(ChatApi).pipe(
  Layer.provide([
    UsersHandlerLive,
    PostsHandlerLive,
    EngagementHandlerLive,
    ChatsHandlerLive,
    SearchHandlerLive,
    AttachmentsHandlerLive,
    VersionHandlerLive,
    RealtimeHandlerLive,
    AdminHandlerLive,
    GamesHandlerLive,
    NotificationsHandlerLive,
  ]),
  // provideMerge, not provide: the request pipeline resolves the API's
  // middleware again when the routes are served (same as main.ts).
  Layer.provideMerge(
    Layer.mergeAll(AuthenticationLive, SanitizeDecodeErrorsLive),
  ),
);

// Merged into the served app's own output (rather than only provided to
// it) so raw routes — which look their services up per request, unlike
// `ChatApi`'s handler groups — find them too.
const ServicesLive = Layer.mergeAll(
  RealtimeConnectionsLive,
  TokenVersionCacheLive,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      InMemoryPresenceStoreLive,
      InMemoryRateLimiterLive,
      JwtLive,
      InMemoryWsTicketLive,
      AttachmentStorageLive,
    ),
  ),
);

export interface TestRunOptions {
  // Replaces the PubSub (default: a fresh InMemoryPubSubLive per run). One
  // instance per run is shared by the server and the test body.
  readonly pubSub?: Layer.Layer<PubSub>;
  // Replaces the migrated, reset-per-run test database.
  readonly db?: Layer.Layer<Db>;
  // Extra raw routes served next to `ChatApi` (`/ws`, `/health`, …). Their
  // per-request services must be among the ones this harness provides.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly routes?: Layer.Layer<never, never, any>;
  // Server-wide middleware, as main.ts passes to `HttpRouter.serve`.
  readonly middleware?: <E, R>(
    httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  >;
  // Called at the start of every run (e.g. to clear state a test records).
  readonly beforeEach?: () => void;
}

type TestServices = HttpClient.HttpClient | Db | PubSub;

export interface TestContext {
  // The raw web handler, for tests that build their own requests.
  readonly handler: (request: Request) => Promise<Response>;
}

// Returns `run`, which builds a fresh app (fresh database contents, fresh
// in-memory services) for each test and runs `effect` against it with an
// `HttpClient` pointed at it. Call once at module top level — it registers
// the test database's `afterAll` cleanup.
export const makeTestRun = (options: TestRunOptions = {}) => {
  const { getTestDb } = makeTestDbAccessor();

  return async <A, E>(
    effect:
      | Effect.Effect<A, E, TestServices>
      | ((context: TestContext) => Effect.Effect<A, E, TestServices>),
  ): Promise<A> => {
    options.beforeEach?.();
    let dbLive = options.db;
    if (!dbLive) {
      const db = await getTestDb();
      await resetTestDb(db);
      dbLive = Layer.succeed(Db, db);
    }
    const pubSub = Effect.runSync(
      Effect.service(PubSub).pipe(
        Effect.provide(options.pubSub ?? InMemoryPubSubLive),
      ),
    );
    const pubSubLive = Layer.succeed(PubSub, pubSub);

    const { handler, dispose } = HttpRouter.toWebHandler(
      Layer.mergeAll(
        ApiLive,
        // The extra routes' requirements are untyped (see `routes` above);
        // everything they can ask for is merged in below.
        (options.routes ?? Layer.empty) as Layer.Layer<
          never,
          never,
          HttpRouter.HttpRouter
        >,
      ).pipe(
        Layer.provideMerge(ServicesLive),
        Layer.provideMerge(dbLive),
        Layer.provideMerge(pubSubLive),
        Layer.provide(BunHttpServer.layerHttpServices),
      ),
      {
        disableLogger: true,
        middleware: (httpApp) =>
          options.middleware ? options.middleware(httpApp) : httpApp,
      },
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
        (typeof effect === "function" ? effect({ handler }) : effect).pipe(
          Effect.provide(TestClientLayer),
          Effect.provide(dbLive),
          Effect.provide(pubSubLive),
        ),
      );
    } finally {
      await dispose();
    }
  };
};
