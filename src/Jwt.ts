import { Config, Context, Data, Effect, Layer } from "effect";

// Short-lived token sent as a Bearer credential on each request.
const ACCESS_TOKEN_TTL_SECONDS = 60 * 15; // 15 minutes
// Long-lived token used only to mint new access tokens.
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type TokenType = "access" | "refresh";

export type TokenClaims = {
  readonly sub: number;
  readonly username: string;
  readonly type: TokenType;
  readonly iat: number;
  readonly exp: number;
};

export type TokenUser = {
  readonly id: number;
  readonly username: string;
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
    return JSON.parse(Buffer.from(body!, "base64url").toString()) as TokenClaims;
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
    readonly signRefreshToken: (user: TokenUser) => Effect.Effect<string>;
    readonly verifyAccessToken: (
      token: string,
    ) => Effect.Effect<TokenUser, InvalidToken>;
  }
>() {}

export const JwtLive = Layer.effect(
  Jwt,
  Effect.gen(function* () {
    const secret = yield* Config.string("JWT_SECRET");

    const sign = (user: TokenUser, type: TokenType, ttl: number) =>
      Effect.promise(() => {
        const now = Math.floor(Date.now() / 1000);
        return signHs256(
          {
            sub: user.id,
            username: user.username,
            type,
            iat: now,
            exp: now + ttl,
          },
          secret,
        );
      });

    return {
      signAccessToken: (user) =>
        sign(user, "access", ACCESS_TOKEN_TTL_SECONDS),
      signRefreshToken: (user) =>
        sign(user, "refresh", REFRESH_TOKEN_TTL_SECONDS),
      verifyAccessToken: (token) =>
        Effect.gen(function* () {
          const claims = yield* Effect.promise(() =>
            verifyHs256(token, secret),
          );
          const now = Math.floor(Date.now() / 1000);
          if (!claims || claims.type !== "access" || claims.exp <= now)
            return yield* Effect.fail(
              new InvalidToken({ reason: "invalid or expired access token" }),
            );
          return { id: claims.sub, username: claims.username };
        }),
    };
  }),
);
