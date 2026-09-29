// The emoji a lobby's players and spectators can fling at each other (see
// `game_reaction` in RealtimeSocket.ts). A fixed, small set rather than any
// emoji: a reaction is relayed to the whole lobby room without being stored,
// so it can't be moderated after the fact — and a closed set of pure
// sentiments carries no words, so it stays on even while a Sketchy game
// keeps its lobby chat closed. The client's `GAME_REACTIONS`
// (web/src/lib/games/reactions.ts) must list the same emoji.
export const GAME_REACTIONS = [
  "👏",
  "🔥",
  "😂",
  "😮",
  "😱",
  "💀",
  "❤️",
  "👀",
] as const;

export type GameReaction = (typeof GAME_REACTIONS)[number];

export const isGameReaction = (value: unknown): value is GameReaction =>
  typeof value === "string" &&
  (GAME_REACTIONS as ReadonlyArray<string>).includes(value);
