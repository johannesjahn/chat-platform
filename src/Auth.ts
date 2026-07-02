import {
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "@effect/platform";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
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
    return {
      bearer: (token) =>
        jwt
          .verifyAccessToken(Redacted.value(token))
          .pipe(
            Effect.mapError(
              () => new Unauthorized({ message: "Invalid or expired token" }),
            ),
          ),
    };
  }),
);
