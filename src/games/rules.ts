import type { GameId } from "../Api.ts";
import { typingRules } from "./typing.ts";

// What makes one game different from another. Everything else — lobbies,
// seats, the realtime rooms, results and the leaderboard — is shared
// plumbing in GamesHandler.ts, keyed by the game's slug. A new game supplies
// one of these and adds its slug to `GameId` (Api.ts).
export type GameRules = {
  // How long between the host pressing start and the race going live.
  readonly countdownMs: number;
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

export const GAME_RULES: Record<GameId, GameRules> = {
  typing: typingRules,
};
