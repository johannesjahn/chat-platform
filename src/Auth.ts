import {
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "@effect/platform";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { Db } from "./Db.ts";
import { users } from "./db/schema.ts";
import { Jwt, type TokenUser } from "./Jwt.ts";

// Returned (401) when a protected endpoint is called without a valid access
// token. Deliberately generic so it doesn't reveal why the token was rejected.
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 401 }),
) {}

// The authenticated user, made available to handlers behind the middleware.
export class CurrentUser extends Context.Tag("CurrentUser")<
  CurrentUser,
  TokenUser
>() {}

// Bearer-token authentication middleware. Endpoints tagged with `.middleware`
// require a valid `Authorization: Bearer <accessToken>` header.
export class Authentication extends HttpApiMiddleware.Tag<Authentication>()(
  "Authentication",
  {
    failure: Unauthorized,
    provides: CurrentUser,
    security: { bearer: HttpApiSecurity.bearer },
  },
) {}

export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const jwt = yield* Jwt;
    const db = yield* Db;
    const invalid = new Unauthorized({ message: "Invalid or expired token" });
    return {
      bearer: (token) =>
        Effect.gen(function* () {
          const tokenUser = yield* jwt
            .verifyAccessToken(Redacted.value(token))
            .pipe(Effect.mapError(() => invalid));

          // Reject a token signed before the user's token_version was last
          // bumped (forced logout, future password change) — otherwise it
          // would keep working up to its own TTL despite the bump.
          const rows = yield* Effect.tryPromise(() =>
            db
              .select({ tokenVersion: users.tokenVersion })
              .from(users)
              .where(eq(users.id, tokenUser.id))
              .limit(1),
          ).pipe(Effect.orDie);
          if (rows[0]?.tokenVersion !== tokenUser.tokenVersion)
            return yield* Effect.fail(invalid);

          return tokenUser;
        }),
    };
  }),
);
