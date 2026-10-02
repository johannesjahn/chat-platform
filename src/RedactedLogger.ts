import {
  HttpMiddleware,
  HttpServerError,
  HttpServerRequest,
  type HttpServerResponse,
} from "effect/http";
import { type Cause, Context, Effect, Option } from "effect";
import crypto from "crypto";
import { clientIp } from "./ClientIp.ts";

// Query params that carry credentials and must never reach logs verbatim.
// `ticket` covers the `/ws?ticket=` handshake (see RealtimeSocket.ts —
// browsers can't set an Authorization header on a WebSocket upgrade, so a
// short-lived single-use ticket travels in the URL instead of the bearer
// access token itself, see WsTicket.ts); `token` is kept for defense in
// depth even though nothing issues it anymore; the rest are redacted
// defensively in case a future auth mechanism puts a credential in a query
// param too.
const SENSITIVE_PARAMS = [
  "ticket",
  "token",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "password",
  "secret",
  "api_key",
  "apiKey",
];

export const redactUrl = (url: string): string => {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return url;
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  let redacted = false;
  for (const key of SENSITIVE_PARAMS) {
    if (params.has(key)) {
      params.set(key, "REDACTED");
      redacted = true;
    }
  }
  return redacted ? `${url.slice(0, queryIndex)}?${params.toString()}` : url;
};

// Ephemeral salt generated randomly on startup to prevent dictionary attacks
// on IPv4 hashes while still allowing request correlation during the process lifetime.
const IP_HASH_SALT = crypto.randomBytes(16).toString("hex");

/**
 * Hashes a resolved client IP with an ephemeral salt.
 */
export const hashIp = (ip: string): string => {
  if (ip === "unknown") return "unknown";
  return crypto
    .createHash("sha256")
    .update(ip + IP_HASH_SALT)
    .digest("hex")
    .slice(0, 16);
};

// Per-request holder for the authenticated username, logged by
// redactedLogger. A mutable box rather than a plain value because the logger
// wraps the whole request: authentication runs further in (Auth.ts's
// middleware, UsersHandler.ts's login/refresh) and only scopes services to
// what it wraps, so the logger couldn't see a value provided there — it can
// see a write into the box it provided itself. The default box (outside any
// request) just absorbs writes.
export const LogUser = Context.Reference<{ username: string | undefined }>(
  "LogUser",
  { defaultValue: () => ({ username: undefined }) },
);

export const setLogUser = (username: string): Effect.Effect<void> =>
  Effect.map(Effect.service(LogUser), (box) => {
    box.username = username;
  });

// `HttpMiddleware.withLoggerDisabled` only silences effect's own logger
// middleware (its flag isn't exported), so raw routes mark themselves here
// for redactedLogger instead.
const loggerDisabledRequests = new WeakSet<object>();

export const withLoggerDisabled = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.flatMap(
    Effect.service(HttpServerRequest.HttpServerRequest),
    (request) => {
      loggerDisabledRequests.add(request.source);
      return self;
    },
  );

// Numbers each request's log span, process-wide.
let spanCounter = 0;

// A drop-in replacement for `HttpMiddleware.logger` that redacts credential
// query params (see SENSITIVE_PARAMS) from the logged URL, appends a hashed
// representation of the resolved client IP, and appends the authenticated username if available.
// Only the log annotation is redacted — the request passed to `httpApp` is untouched.
export const redactedLogger = HttpMiddleware.make(
  <E, R>(
    httpApp: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E,
      R | HttpServerRequest.HttpServerRequest
    >,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > => {
    const logged = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const clientIpHash = hashIp(yield* clientIp);
      const url = redactUrl(request.url);
      const logUser: { username: string | undefined } = {
        username: undefined,
      };
      const exit = yield* Effect.exit(
        Effect.provideService(httpApp, LogUser, logUser),
      );
      if (loggerDisabledRequests.has(request.source)) return yield* exit;

      const [response, cause] =
        exit._tag === "Failure"
          ? HttpServerError.causeResponseStripped(exit.cause)
          : [exit.value, Option.none<Cause.Cause<unknown>>()];

      const annotations: Record<string, string | number> = {
        "http.method": request.method,
        "http.url": url,
        "http.status": response.status,
        "http.client_ip_hash": clientIpHash,
      };
      if (logUser.username !== undefined) {
        annotations["http.username"] = logUser.username;
      }

      const logMsg =
        exit._tag === "Failure"
          ? Option.isSome(cause)
            ? cause.value
            : "Sent HTTP Response"
          : "Sent HTTP response";

      yield* Effect.annotateLogs(Effect.log(logMsg), annotations);
      return yield* exit;
    });
    return Effect.suspend(() =>
      Effect.withLogSpan(logged, `http.span.${++spanCounter}`),
    );
  },
);
