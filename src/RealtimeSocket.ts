import {
  HttpApiBuilder,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Context, Effect, Option, type Scope } from "effect";
import { RateLimiter } from "./RateLimiter.ts";
import { RealtimeConnections } from "./Realtime.ts";
import { allowedOrigins } from "./WebOrigin.ts";
import { WsTicket } from "./WsTicket.ts";

// Caps handshake attempts per source IP so a connection flood can't exhaust
// server resources upgrading sockets (see issue #41, sub-task of #25). A
// window this short is fine for legitimate reconnects (one ticket mint + one
// upgrade per connection) while still capping a flood tightly.
const WS_HANDSHAKE_MAX_ATTEMPTS_PER_IP = 30;
const WS_HANDSHAKE_WINDOW_SECONDS = 60;

// HttpServerRequest.remoteAddress is populated from the real TCP connection
// by BunHttpServer in production; it's unset in the in-process test harness
// (see RealtimeSocket.test.ts), where every request falls back to the same
// bucket (mirrors clientIp in UsersHandler.ts).
const clientIp = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  return Option.getOrElse(request.remoteAddress, () => "unknown");
});

// A browser `WebSocket` can't set an `Authorization` header on the handshake
// request, so authentication travels as a query param instead — a
// short-lived, single-use ticket (see WsTicket.ts), minted just beforehand
// over normal REST with the real bearer access token, rather than that
// access token itself (see issue #26).
const getTicket = (originalUrl: string): string | null => {
  try {
    return new URL(originalUrl).searchParams.get("ticket");
  } catch {
    return null;
  }
};

// Defense-in-depth against cross-site WebSocket hijacking: a same-origin
// upgrade either omits `Origin` (non-browser clients) or sends one from the
// configured allowlist. A cross-origin browser page can still *attempt* the
// handshake, but a mismatched Origin rejects it before the ticket is even
// checked. Exploitability is already limited — auth rides on a ticket freshly
// minted from a token in `localStorage`, not an ambient cookie — but this
// mirrors the CORS allowlist (see WebOrigin.ts) for the one path CORS itself
// doesn't cover (a WebSocket upgrade isn't a CORS-checked request).
const isAllowedOrigin = (origin: string | undefined): boolean =>
  !origin || allowedOrigins.includes(origin);

const wsHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const wsTicket = yield* WsTicket;
  const connections = yield* RealtimeConnections;
  const limiter = yield* RateLimiter;

  if (!isAllowedOrigin(request.headers["origin"])) {
    return HttpServerResponse.text("Origin not allowed", { status: 403 });
  }

  const ip = yield* clientIp;
  const rateLimit = yield* limiter.consume(
    `ws:handshake:ip:${ip}`,
    WS_HANDSHAKE_MAX_ATTEMPTS_PER_IP,
    WS_HANDSHAKE_WINDOW_SECONDS,
  );
  if (!rateLimit.allowed) {
    return HttpServerResponse.text("Too many connection attempts", {
      status: 429,
      headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
    });
  }

  const ticket = getTicket(request.originalUrl);
  if (!ticket) {
    return HttpServerResponse.text("Missing ticket", { status: 401 });
  }

  const userId = yield* wsTicket.consume(ticket);
  if (userId === null) {
    return HttpServerResponse.text("Invalid or expired ticket", {
      status: 401,
    });
  }

  const socket = yield* HttpServerRequest.upgrade;
  const write = yield* socket.writer;
  const unregister = yield* connections.register(userId, write);

  // `register` only pushes a `presence` event for a state *transition* (see
  // Realtime.ts), so a client connecting after others are already online
  // would otherwise never learn about them. This hands the new connection an
  // explicit snapshot of who's online right now, targeted at just this
  // socket rather than broadcast — every other connected client already
  // knows this from the `online: true` transition `register` just triggered
  // above.
  const online = yield* connections.onlineUserIds;
  for (const onlineUserId of online) {
    yield* write(
      JSON.stringify({ type: "presence", userId: onlineUserId, online: true }),
    ).pipe(Effect.ignore);
  }

  // Blocks for the lifetime of the connection — the frontend never sends
  // anything meaningful (a periodic ping to defeat idle timeouts, at most),
  // so incoming messages are ignored.
  yield* socket
    .run(() => Effect.void)
    .pipe(Effect.ensuring(Effect.sync(unregister)));

  return HttpServerResponse.empty();
});

// Raw route (not part of the typed `ChatApi`) that upgrades `/ws` to a
// WebSocket, authenticates it with a single-use ticket redeemed via
// WsTicket (minted over REST — see RealtimeHandler.ts — with the same
// access token used for other calls), and registers the connection so chat
// and post mutations can push `chat_updated`/`post_changed` events — to
// exactly the affected chat's participants, or to every connected user for
// posts (see Realtime.ts). Added directly to `HttpApiBuilder.Router` — the
// same shared router `ChatApi`'s endpoints are attached to — so it's served
// alongside them by the one Bun server.
//
// `router.get` requires its handler's requirements to already be resolved
// down to what the router provides on every request (`HttpServerRequest`,
// `Scope`, …) — it can't itself carry extra services like `WsTicket` or
// `RealtimeConnections` through to the caller. So, the same way
// `HttpApiBuilder.group` wires up endpoint handlers, this captures the
// ambient context (which does include `WsTicket`/`RealtimeConnections`/
// `RateLimiter`, supplied by whoever builds this layer — see main.ts) and
// merges it back into the handler via `mapInputContext`, turning "needs
// WsTicket | RealtimeConnections | RateLimiter" into "needs nothing more",
// while still leaving those three as this Layer's own unresolved
// requirements for main.ts to provide.
export const RealtimeSocketRouteLive = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      WsTicket | RealtimeConnections | RateLimiter
    >();
    yield* router.get(
      "/ws",
      wsHandler.pipe(
        Effect.mapInputContext(
          (
            input: Context.Context<
              HttpServerRequest.HttpServerRequest | Scope.Scope
            >,
          ) => Context.merge(context, input),
        ),
      ),
    );
  }),
);
