import {
  HttpApiBuilder,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Context, Effect, type Scope } from "effect";
import { ChatConnections } from "./ChatEvents.ts";
import { Jwt } from "./Jwt.ts";

// A browser `WebSocket` can't set an `Authorization` header on the handshake
// request, so the access token travels as a query param instead — same
// token the REST client sends as a bearer credential, just relocated.
const getToken = (originalUrl: string): string | null => {
  try {
    return new URL(originalUrl).searchParams.get("token");
  } catch {
    return null;
  }
};

const wsHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const jwt = yield* Jwt;
  const connections = yield* ChatConnections;

  const token = getToken(request.originalUrl);
  if (!token) {
    return HttpServerResponse.text("Missing token", { status: 401 });
  }

  const user = yield* jwt
    .verifyAccessToken(token)
    .pipe(Effect.catchAll(() => Effect.succeed(null)));
  if (!user) {
    return HttpServerResponse.text("Invalid or expired token", {
      status: 401,
    });
  }

  const socket = yield* HttpServerRequest.upgrade;
  const write = yield* socket.writer;
  const unregister = yield* connections.register(user.id, write);

  // Blocks for the lifetime of the connection — the frontend never sends
  // anything meaningful (a periodic ping to defeat idle timeouts, at most),
  // so incoming messages are ignored.
  yield* socket
    .run(() => Effect.void)
    .pipe(Effect.ensuring(Effect.sync(unregister)));

  return HttpServerResponse.empty();
});

// Raw route (not part of the typed `ChatApi`) that upgrades `/ws` to a
// WebSocket, authenticates it with the same access token used for REST
// calls, and registers the connection so chat mutations can push
// `chat_updated` events to exactly the users who are participants of the
// affected chat. Added directly to `HttpApiBuilder.Router` — the same
// shared router `ChatApi`'s endpoints are attached to — so it's served
// alongside them by the one Bun server.
//
// `router.get` requires its handler's requirements to already be resolved
// down to what the router provides on every request (`HttpServerRequest`,
// `Scope`, …) — it can't itself carry extra services like `Jwt` or
// `ChatConnections` through to the caller. So, the same way
// `HttpApiBuilder.group` wires up endpoint handlers, this captures the
// ambient context (which does include `Jwt`/`ChatConnections`, supplied by
// whoever builds this layer — see main.ts) and merges it back into the
// handler via `mapInputContext`, turning "needs Jwt | ChatConnections" into
// "needs nothing more", while still leaving those two as this Layer's own
// unresolved requirements for main.ts to provide.
export const ChatSocketRouteLive = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Jwt | ChatConnections>();
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
