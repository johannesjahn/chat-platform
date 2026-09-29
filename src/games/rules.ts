import { MAX_GAME_LOBBY_PLAYERS, type GameId } from "../Api.ts";
import {
  DRAWING_COUNTDOWN_MS,
  DRAWING_MAX_PLAYERS,
  DRAWING_MIN_PLAYERS,
} from "./drawing/rules.ts";
import { typingRules } from "./typing.ts";

// What every game has in common, whatever it plays like.
type CommonRules = {
  // How long between the host pressing start and play going live.
  readonly countdownMs: number;
  // Seats: the host can't start below `minPlayers`, and a lobby turns new
  // players away at `maxPlayers`.
  readonly minPlayers: number;
  readonly maxPlayers: number;
};

// A race: everyone plays the same content at once, and each player's finish
// is scored the moment it lands (the typing race).
export type RaceRules = CommonRules & {
  readonly kind: "race";
  // How long after `startsAt` the race closes for stragglers.
  readonly timeLimitMs: number;
  // The content raced this round, revealed when the countdown starts.
  // `previous` is last round's, so a rematch can avoid repeating it.
  readonly pickPassage: (previous: string | null) => string;
  // Validates and scores a finish entirely server-side. `durationMs` is
  // measured by the server from `startsAt`, never supplied by the client.
  readonly score: (input: {
    readonly passage: string;
    readonly typed: string;
    readonly errors: number;
    readonly durationMs: number;
  }) =>
    | { readonly ok: true; readonly score: number; readonly accuracy: number }
    | { readonly ok: false; readonly reason: string };
};

// Sketchy: a multi-stage party game whose stages, secrets, and scores live
// in src/games/drawing/ and are scored all at once when the game ends.
export type DrawingRules = CommonRules & { readonly kind: "drawing" };

// What makes one game different from another. Everything else — lobbies,
// seats, the realtime rooms, results and the leaderboard — is shared
// plumbing in GamesHandler.ts, keyed by the game's slug. A new game supplies
// one of these and adds its slug to `GameId` (Api.ts).
export type GameRules = RaceRules | DrawingRules;

export const GAME_RULES: Record<GameId, GameRules> = {
  typing: {
    ...typingRules,
    kind: "race",
    minPlayers: 1,
    maxPlayers: MAX_GAME_LOBBY_PLAYERS,
  },
  drawing: {
    kind: "drawing",
    countdownMs: DRAWING_COUNTDOWN_MS,
    minPlayers: DRAWING_MIN_PLAYERS,
    maxPlayers: DRAWING_MAX_PLAYERS,
  },
};
