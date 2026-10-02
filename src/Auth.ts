import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import { eq } from "drizzle-orm";
import {
  Cache,
  Context,
  Duration,
  Effect,
  Layer,
  Redacted,
  Schema,
} from "effect";
import { Db } from "./Db.ts";
import { PubSub } from "./PubSub.ts";
import { users } from "./db/schema.ts";
import { Jwt, type TokenUser } from "./Jwt.ts";
import { setLogUser } from "./RedactedLogger.ts";

// Returned (401) when a protected endpoint is called without a valid access
// token. Deliberately generic so it doesn't reveal why the token was rejected.
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

// The authenticated user, made available to handlers behind the middleware.
export class CurrentUser extends Context.Service<CurrentUser, TokenUser>()(
  "CurrentUser",
) {}

// Bearer-token authentication middleware. Endpoints tagged with `.middleware`
// require a valid `Authorization: Bearer <accessToken>` header.
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentUser }
>()("Authentication", {
  error: Unauthorized,
  security: { bearer: HttpApiSecurity.bearer },
}) {}

export class TokenVersionCache extends Context.Service<
  TokenVersionCache,
  Cache.Cache<number, number, never>
>()("TokenVersionCache") {}

export const TokenVersionCacheLive = Layer.effect(
  TokenVersionCache,
  Effect.gen(function* () {
    const db = yield* Db;
    const pubsub = yield* PubSub;
    const cache = yield* Cache.make({
      capacity: 10000,
      timeToLive: Duration.seconds(5),
      lookup: (userId: number) =>
        Effect.gen(function* () {
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({ tokenVersion: users.tokenVersion })
              .from(users)
              .where(eq(users.id, userId))
              .limit(1),
          ).pipe(Effect.orDie);
          return rows[0]?.tokenVersion ?? -1;
        }),
    });

    yield* pubsub.subscribe("auth:invalidation", (userIdStr) =>
      Effect.gen(function* () {
        const userId = Number(userIdStr);
        if (!isNaN(userId)) {
          yield* Cache.invalidate(cache, userId);
        }
      }),
    );

    return cache;
  }),
);

export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const jwt = yield* Jwt;
    const cache = yield* TokenVersionCache;
    const invalid = new Unauthorized({ message: "Invalid or expired token" });
    return Authentication.of({
      bearer: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const tokenUser = yield* jwt
            .verifyAccessToken(Redacted.value(credential))
            .pipe(Effect.mapError(() => invalid));

          // Reject a token signed before the user's token_version was last
          // bumped (forced logout, future password change) — otherwise it
          // would keep working up to its own TTL despite the bump.
          const currentVersion = yield* Cache.get(cache, tokenUser.id);
          if (currentVersion !== tokenUser.tokenVersion)
            return yield* Effect.fail(invalid);

          yield* setLogUser(tokenUser.username);

          return yield* Effect.provideService(
            httpEffect,
            CurrentUser,
            tokenUser,
          );
        }),
    });
  }),
);
