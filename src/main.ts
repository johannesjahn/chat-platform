import { HttpRouter } from "effect/http";
import { HttpApiBuilder, HttpApiSwagger } from "effect/http-api";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, Effect, Layer, Metric } from "effect";
import { ChatApi } from "./Api.ts";
import { ActiveUsersMetricsLive } from "./ActiveUsersMetrics.ts";
import { AdminHandlerLive } from "./AdminHandler.ts";
import { AttachmentCleanupLive } from "./AttachmentCleanup.ts";
import { AttachmentsHandlerLive } from "./AttachmentsHandler.ts";
import { AttachmentStorageLive } from "./AttachmentStorage.ts";
import { AvatarRouteLive } from "./AvatarRoute.ts";
import { AuthenticationLive, TokenVersionCacheLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { DbLive } from "./Db.ts";
import { SanitizeDecodeErrorsLive } from "./DecodeErrorSanitizer.ts";
import { globalRateLimit } from "./GlobalRateLimit.ts";
import { HealthRouteLive, ReadyRouteLive } from "./Health.ts";
import { JwtLive } from "./Jwt.ts";
import { MetricsRouteLive, recordHttpMetrics } from "./Metrics.ts";
import { EngagementHandlerLive } from "./EngagementHandler.ts";
import { GamesHandlerLive } from "./GamesHandler.ts";
import { NotificationsHandlerLive } from "./NotificationsHandler.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { PresenceStoreLive } from "./Presence.ts";
import { PubSubLive } from "./PubSub.ts";
import { RateLimiterLive } from "./RateLimiter.ts";
import { RealtimeConnectionsLive } from "./Realtime.ts";
import { RealtimeHandlerLive } from "./RealtimeHandler.ts";
import { RealtimeSocketRouteLive } from "./RealtimeSocket.ts";
import { redactedLogger } from "./RedactedLogger.ts";
import { RefreshTokenCleanupLive } from "./RefreshTokenCleanup.ts";
import { SearchHandlerLive } from "./SearchHandler.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import { VersionHandlerLive } from "./VersionHandler.ts";
import { allowedOrigins } from "./WebOrigin.ts";
import { WsTicketLive } from "./WsTicket.ts";

const CorsLive = HttpRouter.cors({
  allowedOrigins,
  // PATCH is used by updateUserRole (/users/:id/role) and updateComment
  // (/comments/:id) — omitting it here fails preflight for both, since
  // Authorization (a non-safelisted header) forces every authenticated
  // request through a preflight regardless of method.
  allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

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
  // middleware again when the routes are served, not just here.
  Layer.provideMerge(
    Layer.mergeAll(AuthenticationLive, SanitizeDecodeErrorsLive),
  ),
);

const RoutesLive = Layer.mergeAll(
  ApiLive,
  HttpApiSwagger.layer(ChatApi, { path: "/docs" }),
  CorsLive,
  // Raw `/ws` route, attached to the same shared router as `ChatApi` — see
  // RealtimeSocket.ts for why this can't be a typed HttpApiEndpoint.
  RealtimeSocketRouteLive,
  // Raw `/avatars/:token` route serving uploaded avatar bytes from object
  // storage with a long, immutable cache (issue #289) — see AvatarRoute.ts.
  // A raw route (not a typed `ChatApi` endpoint) because it returns binary
  // image bytes with custom cache headers, not a JSON-schema response.
  AvatarRouteLive,
  // Raw `/health` (liveness), `/ready` (readiness), and `/metrics` routes —
  // see Health.ts/Metrics.ts.
  HealthRouteLive,
  ReadyRouteLive,
  MetricsRouteLive,
);

const HttpServerLive = HttpRouter.serve(RoutesLive, {
  // Replaced by redactedLogger below.
  disableLogger: true,
  // globalRateLimit sits innermost (closest to the actual router) so a
  // request it rejects still gets logged and counted in `/metrics` like any
  // other response, rather than disappearing before either wrapper sees it.
  middleware: (httpApp) =>
    redactedLogger(recordHttpMetrics(globalRateLimit(httpApp))),
}).pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const port = yield* Config.Int("PORT").pipe(Config.withDefault(3000));
        return BunHttpServer.layer({ port });
      }),
    ),
  ),
);

// Every shared service, built once and handed to the server, its routes and
// handlers, and the background jobs alike.
const ServicesLive = Layer.mergeAll(
  RealtimeConnectionsLive,
  TokenVersionCacheLive,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      DbLive,
      PubSubLive,
      PresenceStoreLive,
      JwtLive,
      RateLimiterLive,
      WsTicketLive,
      AttachmentStorageLive,
    ),
  ),
);

const ServerLive = Layer.mergeAll(
  HttpServerLive,
  RefreshTokenCleanupLive,
  AttachmentCleanupLive,
  ActiveUsersMetricsLive,
).pipe(
  Layer.provide(ServicesLive),
  // Effect's fiber counters (child_fibers_*), off by default since v4 —
  // rendered on `/metrics` alongside the app's own (see Metrics.ts).
  Layer.provide(Metric.enableRuntimeMetricsLayer),
);

BunRuntime.runMain(Layer.launch(ServerLive));
