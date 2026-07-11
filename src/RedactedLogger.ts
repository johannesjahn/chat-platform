import {
  HttpMiddleware,
  HttpServerError,
  HttpServerRequest,
  type HttpApp,
} from "@effect/platform";
import { Context, Effect, FiberRef } from "effect";
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

// FiberRef used to store the authenticated username for logging in redactedLogger.
export const currentLogUser = FiberRef.unsafeMake<string | undefined>(
  undefined,
);

// A drop-in replacement for `HttpMiddleware.logger` that redacts credential
// query params (see SENSITIVE_PARAMS) from the logged URL, appends a hashed
// representation of the resolved client IP, and appends the authenticated username if available.
// Only the log annotation is redacted — the request passed to `httpApp` is untouched.
export const redactedLogger = HttpMiddleware.make(
  <E, R>(httpApp: HttpApp.Default<E, R>): HttpApp.Default<E, R> => {
    let counter = 0;
    return Effect.flatMap(clientIp, (ip) => {
      const clientIpHash = hashIp(ip);
      return Effect.withFiberRuntime((fiber) => {
        const request = Context.unsafeGet(
          fiber.currentContext,
          HttpServerRequest.HttpServerRequest,
        );
        const url = redactUrl(request.url);
        return Effect.withLogSpan(
          Effect.flatMap(Effect.exit(httpApp), (exit) => {
            if (fiber.getFiberRef(HttpMiddleware.loggerDisabled)) {
              return exit;
            }

            return Effect.flatMap(FiberRef.get(currentLogUser), (username) => {
              const [response, cause] =
                exit._tag === "Failure"
                  ? HttpServerError.causeResponseStripped(exit.cause)
                  : [exit.value, undefined];

              const annotations: Record<string, string | number> = {
                "http.method": request.method,
                "http.url": url,
                "http.status": response.status,
                "http.client_ip_hash": clientIpHash,
              };
              if (username !== undefined) {
                annotations["http.username"] = username;
              }

              const logMsg =
                exit._tag === "Failure"
                  ? cause?._tag === "Some"
                    ? cause.value
                    : "Sent HTTP Response"
                  : "Sent HTTP response";

              return Effect.zipRight(
                Effect.annotateLogs(Effect.log(logMsg), annotations),
                exit,
              );
            });
          }),
          `http.span.${++counter}`,
        );
      });
    });
  },
);
