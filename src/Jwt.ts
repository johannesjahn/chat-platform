import { Config, Context, Data, Effect, Layer } from "effect";

// Short-lived token sent as a Bearer credential on each request.
const ACCESS_TOKEN_TTL_SECONDS = 60 * 15; // 15 minutes
// Long-lived token used only to mint new access tokens.
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type TokenType = "access" | "refresh";

// Kept in sync with Api.ts's `UserRole` — not imported directly, to avoid a
// circular import (Api.ts -> Auth.ts -> Jwt.ts).
export type UserRole = "user" | "admin";

export type TokenClaims = {
  readonly sub: number;
  readonly username: string;
  readonly role: UserRole;
  readonly type: TokenType;
  readonly iat: number;
  readonly exp: number;
  // Random per-token identifier — without it, two tokens signed for the same
  // user within the same second (same iat/exp) would be byte-identical, so
  // e.g. refreshing twice in quick succession wouldn't actually rotate the
  // refresh token to a new string.
  readonly jti: string;
  // Copied from `users.token_version` at signing time. Verification compares
  // this against the user's *current* token_version (fetched fresh from the
  // DB, not trusted from an earlier token) so bumping it — on forced logout
  // or, in future, a password change — invalidates every access and refresh
  // token issued before the bump, immediately rather than at their own TTL.
  readonly tokenVersion: number;
};

export type TokenUser = {
  readonly id: number;
  readonly username: string;
  readonly role: UserRole;
  readonly tokenVersion: number;
};

// Returned only for refresh tokens — the jti is the server-side session
// store's lookup key, and expiresAt lets it size the stored row's lifetime
// to match the token's own.
export type RefreshTokenUser = TokenUser & {
  readonly jti: string;
  readonly expiresAt: Date;
};

const encoder = new TextEncoder();

const base64url = (data: string | Uint8Array): string =>
  Buffer.from(typeof data === "string" ? encoder.encode(data) : data).toString(
    "base64url",
  );

const importKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

// Signs a compact HS256 JWT. Uses Web Crypto (built into Bun) — no dependency.
const signHs256 = async (
  payload: TokenClaims,
  secret: string,
): Promise<string> => {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
};

// Verifies an HS256 JWT's signature (constant-time via Web Crypto) and returns
// its claims, or null if the token is malformed or the signature doesn't match.
const verifyHs256 = async (
  token: string,
  secret: string,
): Promise<TokenClaims | null> => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const key = await importKey(secret);
  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    const decoded = Buffer.from(signature!, "base64url");
    signatureBytes = new Uint8Array(new ArrayBuffer(decoded.length));
    signatureBytes.set(decoded);
  } catch {
    return null;
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    encoder.encode(`${header}.${body}`),
  );
  if (!valid) return null;
  try {
    return JSON.parse(
      Buffer.from(body!, "base64url").toString(),
    ) as TokenClaims;
  } catch {
    return null;
  }
};

// Failure raised when a bearer token is missing, malformed, expired, or not a
// valid access token. Carries no user-facing detail beyond the reason string.
export class InvalidToken extends Data.TaggedError("InvalidToken")<{
  readonly reason: string;
}> {}

export class Jwt extends Context.Tag("Jwt")<
  Jwt,
  {
    readonly signAccessToken: (user: TokenUser) => Effect.Effect<string>;
    readonly signRefreshToken: (user: TokenUser) => Effect.Effect<{
      readonly token: string;
      readonly jti: string;
      readonly expiresAt: Date;
    }>;
    readonly verifyAccessToken: (
      token: string,
    ) => Effect.Effect<TokenUser, InvalidToken>;
    readonly verifyRefreshToken: (
      token: string,
    ) => Effect.Effect<RefreshTokenUser, InvalidToken>;
  }
>() {}

export const JwtLive = Layer.effect(
  Jwt,
  Effect.gen(function* () {
    const secret = yield* Config.string("JWT_SECRET");

    const sign = (
      user: TokenUser,
      type: TokenType,
      ttl: number,
    ): Effect.Effect<{
      readonly token: string;
      readonly jti: string;
      readonly expiresAt: Date;
    }> =>
      Effect.promise(async () => {
        const now = Math.floor(Date.now() / 1000);
        const jti = crypto.randomUUID();
        const exp = now + ttl;
        const token = await signHs256(
          {
            sub: user.id,
            username: user.username,
            role: user.role,
            type,
            iat: now,
            exp,
            jti,
            tokenVersion: user.tokenVersion,
          },
          secret,
        );
        return { token, jti, expiresAt: new Date(exp * 1000) };
      });

    const verify = (
      token: string,
      type: TokenType,
    ): Effect.Effect<RefreshTokenUser, InvalidToken> =>
      Effect.gen(function* () {
        const claims = yield* Effect.promise(() => verifyHs256(token, secret));
        const now = Math.floor(Date.now() / 1000);
        if (!claims || claims.type !== type || claims.exp <= now)
          return yield* Effect.fail(
            new InvalidToken({ reason: `invalid or expired ${type} token` }),
          );
        return {
          id: claims.sub,
          username: claims.username,
          role: claims.role,
          jti: claims.jti,
          expiresAt: new Date(claims.exp * 1000),
          tokenVersion: claims.tokenVersion,
        };
      });

    return {
      signAccessToken: (user) =>
        sign(user, "access", ACCESS_TOKEN_TTL_SECONDS).pipe(
          Effect.map(({ token }) => token),
        ),
      signRefreshToken: (user) =>
        sign(user, "refresh", REFRESH_TOKEN_TTL_SECONDS),
      verifyAccessToken: (token) => verify(token, "access"),
      verifyRefreshToken: (token) => verify(token, "refresh"),
    };
  }),
);
