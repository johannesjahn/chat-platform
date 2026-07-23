import { HttpApiBuilder, HttpApiSwagger } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { ChatApi } from "./Api.ts";
import { ActiveUsersMetricsLive } from "./ActiveUsersMetrics.ts";
import { AttachmentCleanupLive } from "./AttachmentCleanup.ts";
import { AttachmentsHandlerLive } from "./AttachmentsHandler.ts";
import { AttachmentStorageLive } from "./AttachmentStorage.ts";
import { AuthenticationLive, TokenVersionCacheLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { DbLive } from "./Db.ts";
import { SanitizeDecodeErrorsLive } from "./DecodeErrorSanitizer.ts";
import { globalRateLimit } from "./GlobalRateLimit.ts";
import { HealthRouteLive, ReadyRouteLive } from "./Health.ts";
import { JwtLive } from "./Jwt.ts";
import { MetricsRouteLive, recordHttpMetrics } from "./Metrics.ts";
import { EngagementHandlerLive } from "./EngagementHandler.ts";
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

const CorsLive = HttpApiBuilder.middlewareCors({
  allowedOrigins,
  // PATCH is used by updateUserRole (/users/:id/role) and updateComment
  // (/comments/:id) — omitting it here fails preflight for both, since
  // Authorization (a non-safelisted header) forces every authenticated
  // request through a preflight regardless of method.
  allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(PostsHandlerLive),
  Layer.provide(EngagementHandlerLive),
  Layer.provide(ChatsHandlerLive),
  Layer.provide(SearchHandlerLive),
  Layer.provide(AttachmentsHandlerLive),
  Layer.provide(VersionHandlerLive),
  Layer.provide(RealtimeHandlerLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(TokenVersionCacheLive),
  Layer.provide(JwtLive),
  Layer.provide(CorsLive),
  Layer.provide(SanitizeDecodeErrorsLive),
  Layer.provide(RateLimiterLive),
  Layer.provide(WsTicketLive),
  Layer.provide(PubSubLive),
  Layer.provide(AttachmentStorageLive),
);

const ServerLive = Layer.mergeAll(
  // globalRateLimit sits innermost (closest to the actual router) so a
  // request it rejects still gets logged and counted in `/metrics` like any
  // other response, rather than disappearing before either wrapper sees it.
  HttpApiBuilder.serve((httpApp) =>
    redactedLogger(recordHttpMetrics(globalRateLimit(httpApp))),
  ),
  HttpApiSwagger.layer({ path: "/docs" }),
  // Raw `/ws` route, attached to the same shared router as `ChatApi` — see
  // RealtimeSocket.ts for why this can't be a typed HttpApiEndpoint.
  RealtimeSocketRouteLive,
  // Raw `/health` (liveness), `/ready` (readiness), and `/metrics` routes —
  // see Health.ts/Metrics.ts.
  HealthRouteLive,
  ReadyRouteLive,
  MetricsRouteLive,
  RefreshTokenCleanupLive,
  AttachmentCleanupLive,
  ActiveUsersMetricsLive,
).pipe(
  Layer.provide(ApiLive),
  Layer.provide(RealtimeConnectionsLive),
  Layer.provide(PubSubLive),
  Layer.provide(PresenceStoreLive),
  Layer.provide(JwtLive),
  Layer.provide(RateLimiterLive),
  Layer.provide(WsTicketLive),
  Layer.provide(DbLive),
  // AttachmentCleanupLive (a sibling of ApiLive in the mergeAll above, not
  // nested under it) needs its own AttachmentStorage — ApiLive's internal
  // Layer.provide(AttachmentStorageLive) only satisfies layers within
  // ApiLive itself.
  Layer.provide(AttachmentStorageLive),
  Layer.provide(
    Layer.unwrapEffect(
      Config.integer("PORT").pipe(
        Config.withDefault(3000),
        Effect.map((port) => BunHttpServer.layer({ port })),
      ),
    ),
  ),
);

BunRuntime.runMain(Layer.launch(ServerLive));
