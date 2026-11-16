import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import { eq } from "drizzle-orm";
import {
  Cache,
  Context,
  Duration,
  Effect,
  Layer,
  Metric,
  Option,
  Redacted,
  Schema,
} from "effect";
import { Db, dbQuery } from "./Db.ts";
import { tokenVersionCacheLookupsTotal } from "./Metrics.ts";
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

// Every authenticated request checks the token's version here, so a miss is
// a database query per request. The TTL used to be 5s — shorter than the gap
// between one user's requests to the same pod, so nearly every check missed
// (27% of requests at 10k active users on 4 pods, more with more pods or
// users; issue #833). Revocations don't rely on the TTL: they're pushed on
// `auth:invalidation` the moment a version is bumped, and the only way to
// miss one is for this pod's Redis subscriber to be disconnected — so the
// whole cache is dropped whenever it reconnects. The TTL is just a backstop.
export const TOKEN_VERSION_CACHE_CAPACITY = 100_000;
// A reference so tests can shorten it.
export const TokenVersionCacheTtl = Context.Reference<Duration.Duration>(
  "chat-platform/Auth/TokenVersionCacheTtl",
  { defaultValue: () => Duration.seconds(60) },
);

export const TokenVersionCacheLive = Layer.effect(
  TokenVersionCache,
  Effect.gen(function* () {
    const db = yield* Db;
    const pubsub = yield* PubSub;
    const cache = yield* Cache.make({
      capacity: TOKEN_VERSION_CACHE_CAPACITY,
      timeToLive: yield* TokenVersionCacheTtl,
      lookup: (userId: number) =>
        Effect.gen(function* () {
          const rows = yield* dbQuery(() =>
            db
              .select({ tokenVersion: users.tokenVersion })
              .from(users)
              .where(eq(users.id, userId))
              .limit(1),
          );
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
    // Invalidations published while the subscriber was down are lost.
    yield* pubsub.onReconnect(Cache.invalidateAll(cache));

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
          const cached = yield* Cache.getOption(cache, tokenUser.id);
          yield* Metric.update(
            Metric.withAttributes(tokenVersionCacheLookupsTotal, {
              result: Option.isSome(cached) ? "hit" : "miss",
            }),
            1,
          );
          const currentVersion = Option.isSome(cached)
            ? cached.value
            : yield* Cache.get(cache, tokenUser.id);
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
