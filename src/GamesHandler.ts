import { HttpApiBuilder } from "effect/http-api";
import { Effect } from "effect";
import { ChatApi } from "./Api.ts";
import { Db } from "./Db.ts";
import { drawingHandlers } from "./games/drawingHandlers.ts";
import { finishHandlers } from "./games/finishHandlers.ts";
import { leaderboardHandlers } from "./games/leaderboardHandlers.ts";
import { lobbyChatHandlers } from "./games/lobbyChatHandlers.ts";
import { lobbyHandlers } from "./games/lobbyHandlers.ts";
import { RateLimiter } from "./RateLimiter.ts";
import { RealtimeConnections } from "./Realtime.ts";

// The `games` group, one module per area under src/games/ (issue #811):
//
// - lobbyHandlers — the lobby browser, quick play, join/leave, start,
//   rematch and invites;
// - finishHandlers — scoring a race or a Reflex Rush finish;
// - lobbyChatHandlers — a lobby's chat;
// - drawingHandlers — Sketchy's packs, settings and submissions;
// - leaderboardHandlers — a game's leaderboard.
//
// Shared helpers: lobbyStore.ts (lobby rows → snapshots → the `GameLobby`
// view, with its derived phase) and settlement.ts (writing `game_results`
// once a game is over, and `buildLobby`, which settles before rendering).
// `handleAll` fails to typecheck if an endpoint is left unhandled.
export const GamesHandlerLive = HttpApiBuilder.group(
  ChatApi,
  "games",
  Effect.fn(function* (handlers) {
    const deps = {
      limiter: yield* RateLimiter,
      db: yield* Db,
      connections: yield* RealtimeConnections,
    };
    return handlers.handleAll({
      ...lobbyHandlers(deps),
      ...finishHandlers(deps),
      ...lobbyChatHandlers(deps),
      ...drawingHandlers(deps),
      ...leaderboardHandlers(deps),
    });
  }),
);
