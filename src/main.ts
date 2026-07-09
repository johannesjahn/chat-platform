import { HttpApiBuilder, HttpApiSwagger } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { ChatApi } from "./Api.ts";
import { AuthenticationLive } from "./Auth.ts";
import { ChatsHandlerLive } from "./ChatsHandler.ts";
import { DbLive } from "./Db.ts";
import { HealthRouteLive, ReadyRouteLive } from "./Health.ts";
import { JwtLive } from "./Jwt.ts";
import { PostsHandlerLive } from "./PostsHandler.ts";
import { PresenceStoreLive } from "./Presence.ts";
import { PubSubLive } from "./PubSub.ts";
import { RateLimiterLive } from "./RateLimiter.ts";
import { RealtimeConnectionsLive } from "./Realtime.ts";
import { RealtimeHandlerLive } from "./RealtimeHandler.ts";
import { RealtimeSocketRouteLive } from "./RealtimeSocket.ts";
import { redactedLogger } from "./RedactedLogger.ts";
import { RefreshTokenCleanupLive } from "./RefreshTokenCleanup.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";
import { VersionHandlerLive } from "./VersionHandler.ts";
import { allowedOrigins } from "./WebOrigin.ts";
import { WsTicketLive } from "./WsTicket.ts";

const CorsLive = HttpApiBuilder.middlewareCors({
  allowedOrigins,
  allowedMethods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(PostsHandlerLive),
  Layer.provide(ChatsHandlerLive),
  Layer.provide(VersionHandlerLive),
  Layer.provide(RealtimeHandlerLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(JwtLive),
  Layer.provide(CorsLive),
  Layer.provide(RateLimiterLive),
  Layer.provide(WsTicketLive),
);

const ServerLive = Layer.mergeAll(
  HttpApiBuilder.serve(redactedLogger),
  HttpApiSwagger.layer({ path: "/docs" }),
  // Raw `/ws` route, attached to the same shared router as `ChatApi` — see
  // RealtimeSocket.ts for why this can't be a typed HttpApiEndpoint.
  RealtimeSocketRouteLive,
  // Raw `/health` (liveness) and `/ready` (readiness) routes — see Health.ts.
  HealthRouteLive,
  ReadyRouteLive,
  RefreshTokenCleanupLive,
).pipe(
  Layer.provide(ApiLive),
  Layer.provide(RealtimeConnectionsLive),
  Layer.provide(PubSubLive),
  Layer.provide(PresenceStoreLive),
  Layer.provide(JwtLive),
  Layer.provide(RateLimiterLive),
  Layer.provide(WsTicketLive),
  Layer.provide(DbLive),
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
