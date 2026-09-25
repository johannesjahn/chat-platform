import {
  HttpApiBuilder,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Context, Effect, type Scope } from "effect";
import { clientIp } from "./ClientIp.ts";
import { RateLimiter } from "./RateLimiter.ts";
import {
  gameLobbyRoom,
  isValidRoomName,
  RealtimeConnections,
} from "./Realtime.ts";
import { allowedOrigins } from "./WebOrigin.ts";
import { WsTicket } from "./WsTicket.ts";

// Caps handshake attempts per source IP so a connection flood can't exhaust
// server resources upgrading sockets (see issue #41, sub-task of #25). A
// window this short is fine for legitimate reconnects (one ticket mint + one
// upgrade per connection) while still capping a flood tightly.
const WS_HANDSHAKE_MAX_ATTEMPTS_PER_IP = 30;
const WS_HANDSHAKE_WINDOW_SECONDS = 60;

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

// A racer's client reports its position a few times a second (see
// web/src/lib/games/typing.ts); anything much faster than that is either a
// bug or a flood, and every relayed frame fans out to the whole lobby room.
// A per-connection sliding one-second budget drops the excess silently —
// the next in-budget update carries the latest position anyway.
const GAME_PROGRESS_MAX_PER_SECOND = 15;
// Upper bound on a relayed `progress` — well past the longest passage (see
// src/games/typing.ts); it only guards the relayed number's size, the lanes
// clamp it to the passage length client-side.
const MAX_GAME_PROGRESS = 10_000;

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

// Handles one incoming frame from an authenticated `/ws` connection (`userId`,
// writing through `write`) — see the comment where `wsHandler` below wires it
// up. A factory per connection, since the `game_progress` budget is
// per-connection state. Exported so the control-message handling can be
// unit-tested without a real socket upgrade (see Realtime.test.ts).
export const makeIncomingHandler = (
  connections: Context.Tag.Service<typeof RealtimeConnections>,
  userId: number,
  write: (chunk: string) => Effect.Effect<void, unknown>,
) => {
  // This connection's recent `game_progress` frame timestamps, for the
  // per-second budget above.
  let progressWindow: number[] = [];

  return (data: string | Uint8Array) =>
    Effect.gen(function* () {
      const text =
        typeof data === "string" ? data : new TextDecoder().decode(data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const message = parsed as {
        type?: unknown;
        postId?: unknown;
        room?: unknown;
        lobbyId?: unknown;
        progress?: unknown;
      };

      // Named rooms (see Realtime.ts) — the games hub and individual lobbies.
      // Like post rooms there's no per-room authorization: a lobby is as
      // public as the lobby browser listing it, and spectating is a feature.
      if (
        message.type === "subscribe_room" ||
        message.type === "unsubscribe_room"
      ) {
        if (!isValidRoomName(message.room)) return;
        if (message.type === "subscribe_room") {
          yield* connections.subscribeRoom(message.room, write);
        } else {
          yield* connections.unsubscribeRoom(message.room, write);
        }
        return;
      }

      // A racer's live position, relayed to everyone watching the lobby.
      // Only relayed into a lobby this socket has itself joined the room of,
      // and stamped with the socket's authenticated `userId` — so a client
      // can only ever move its own marker, and only where it's looking.
      // Not persisted and never scored (see GameProgressEvent).
      if (message.type === "game_progress") {
        if (
          !isInteger(message.lobbyId) ||
          !isInteger(message.progress) ||
          message.progress < 0 ||
          message.progress > MAX_GAME_PROGRESS
        ) {
          return;
        }
        const now = Date.now();
        progressWindow = progressWindow.filter((at) => now - at < 1000);
        if (progressWindow.length >= GAME_PROGRESS_MAX_PER_SECOND) return;
        progressWindow.push(now);
        const room = gameLobbyRoom(message.lobbyId);
        if (!(yield* connections.isInRoom(room, write))) return;
        yield* connections.notifyRoom(room, {
          type: "game_progress",
          lobbyId: message.lobbyId,
          userId,
          progress: message.progress,
        });
        return;
      }

      if (!isInteger(message.postId)) return;
      if (message.type === "subscribe_post_comments") {
        yield* connections.subscribePost(message.postId, write);
      } else if (message.type === "unsubscribe_post_comments") {
        yield* connections.unsubscribePost(message.postId, write);
      }
    });
};

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

  // Blocks for the lifetime of the connection. Most incoming frames are
  // ignored (a periodic ping to defeat idle timeouts), but a client viewing a
  // post's comment section sends `subscribe_post_comments`/
  // `unsubscribe_post_comments` to join/leave that post's realtime room (see
  // Realtime.ts), so comment/reply and per-comment-like events reach it
  // without flooding every connected client. The games feature does the same
  // with named rooms (`subscribe_room`/`unsubscribe_room`) and additionally
  // streams `game_progress` frames up the socket. `runRaw` (rather than
  // `run`) preserves text frames as strings; anything that isn't one of these
  // JSON control messages is dropped. No per-post authorization: the feed is
  // public to any signed-in user, so any of them may watch any post's room.
  const handleIncoming = makeIncomingHandler(connections, userId, write);

  yield* socket
    .runRaw((data) => handleIncoming(data))
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
