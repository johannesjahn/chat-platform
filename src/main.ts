import { HttpApiBuilder, HttpApiSwagger, HttpMiddleware } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { ChatApi } from "./Api.ts";
import { AuthenticationLive } from "./Auth.ts";
import { DbLive } from "./Db.ts";
import { JwtLive } from "./Jwt.ts";
import { UsersHandlerLive } from "./UsersHandler.ts";

// Allow the web frontend (different origin) to call the API from the browser.
const CorsLive = HttpApiBuilder.middlewareCors({
  allowedOrigins: [process.env.WEB_ORIGIN ?? "http://localhost:3001"],
  allowedMethods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

const ApiLive = HttpApiBuilder.api(ChatApi).pipe(
  Layer.provide(UsersHandlerLive),
  Layer.provide(AuthenticationLive),
  Layer.provide(JwtLive),
  Layer.provide(CorsLive),
);

const ServerLive = Layer.mergeAll(
  HttpApiBuilder.serve(HttpMiddleware.logger),
  HttpApiSwagger.layer({ path: "/docs" }),
).pipe(
  Layer.provide(ApiLive),
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
