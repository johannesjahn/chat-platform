import {
  createLocalJWKSet,
  createRemoteJWKSet,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import { Config, Context, Data, Effect, Layer } from "effect";

// Google's published signing keys for ID tokens. `createRemoteJWKSet` caches
// them and refetches on an unknown `kid`, so a key rotation needs nothing
// from us.
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

// Google issues ID tokens under either spelling of its issuer.
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

// Raised for any ID token that doesn't verify — bad signature, wrong
// audience or issuer, expired, malformed — or when Google sign-in isn't
// configured at all. `reason` is for logs only; callers answer every case
// with the same generic error.
export class InvalidGoogleToken extends Data.TaggedError("InvalidGoogleToken")<{
  readonly reason: string;
}> {}

// Verifies the ID token the Google Identity Services button hands the
// browser (issue #693) and returns the only claim the app keeps: `sub`,
// Google's stable account id. Email, name and picture are deliberately never
// read, let alone stored.
export class GoogleIdToken extends Context.Service<
  GoogleIdToken,
  {
    // The OAuth client id tokens must be issued to, null when Google sign-in
    // isn't configured. Public — the frontend's button is initialized with it.
    readonly clientId: string | null;
    // `maxAgeSeconds` additionally requires the token to have been issued
    // that recently — for re-confirming an irreversible action with a fresh
    // sign-in rather than one the browser has been holding for an hour.
    readonly verify: (
      idToken: string,
      options?: { readonly maxAgeSeconds?: number },
    ) => Effect.Effect<{ readonly sub: string }, InvalidGoogleToken>;
  }
>()("GoogleIdToken") {}

export const GoogleIdTokenLive = Layer.effect(
  GoogleIdToken,
  Effect.gen(function* () {
    // Unset leaves Google sign-in off — every token is refused, and only the
    // admin password accounts can sign in (the intended break-glass path).
    const clientId = yield* Config.String("GOOGLE_CLIENT_ID").pipe(
      Config.withDefault(""),
    );
    // Points verification at a test key pair instead of Google's JWKS (see
    // GoogleTestSigner.ts). Every other check stays identical. A production
    // process must never trust it: whoever holds the (committed) test
    // private key could mint a token for any account.
    const testPublicKey = yield* Config.String("GOOGLE_TEST_PUBLIC_KEY").pipe(
      Config.withDefault(""),
    );
    if (testPublicKey && process.env.NODE_ENV === "production")
      return yield* Effect.die(
        new Error(
          "GOOGLE_TEST_PUBLIC_KEY must not be set in production — it lets anyone holding the test key sign in as any Google account",
        ),
      );

    const keys: JWTVerifyGetKey = testPublicKey
      ? createLocalJWKSet({ keys: [JSON.parse(testPublicKey)] })
      : createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

    return GoogleIdToken.of({
      clientId: clientId || null,
      verify: (idToken, options) =>
        Effect.gen(function* () {
          if (!clientId)
            return yield* Effect.fail(
              new InvalidGoogleToken({
                reason: "Google sign-in is not configured",
              }),
            );
          const { payload } = yield* Effect.tryPromise({
            try: () =>
              jwtVerify(idToken, keys, {
                algorithms: ["RS256"],
                audience: clientId,
                issuer: GOOGLE_ISSUERS,
                requiredClaims: ["sub", "exp", "iat"],
                ...(options?.maxAgeSeconds !== undefined && {
                  maxTokenAge: options.maxAgeSeconds,
                }),
              }),
            catch: (error) =>
              new InvalidGoogleToken({
                reason: error instanceof Error ? error.message : String(error),
              }),
          });
          if (typeof payload.sub !== "string" || payload.sub.length === 0)
            return yield* Effect.fail(
              new InvalidGoogleToken({ reason: "missing sub" }),
            );
          return { sub: payload.sub };
        }),
    });
  }),
);
