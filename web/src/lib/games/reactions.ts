import { useSyncExternalStore } from "react";
import { sendGameReaction } from "./rooms";

// The emoji anyone watching a lobby can fling across everyone's screen.
// Must list exactly the server's GAME_REACTIONS (src/games/reactions.ts) —
// it drops anything else — and is shown in this order.
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

// One emoji on its way up the screen. Transient socket state with no REST
// resource behind it, so a tiny external store (like the progress store in
// rooms.ts) rather than React Query.
export type FlyingReaction = {
  readonly key: number;
  readonly lobbyId: number;
  readonly userId: number;
  readonly reaction: string;
  // Horizontal lane, 0–1, and a little drift so a burst fans out.
  readonly x: number;
  readonly drift: number;
};

// How long one floats before it's dropped (matches `reaction-float` in
// styles.css), and how many can be in the air at once.
export const REACTION_FLIGHT_MS = 2600;
const MAX_IN_FLIGHT = 40;

let flying: ReadonlyArray<FlyingReaction> = [];
let nextKey = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function noteGameReaction(
  lobbyId: number,
  userId: number,
  reaction: string,
): void {
  const entry: FlyingReaction = {
    key: nextKey++,
    lobbyId,
    userId,
    reaction,
    x: Math.random(),
    drift: Math.random() * 2 - 1,
  };
  flying = [...flying, entry].slice(-MAX_IN_FLIGHT);
  emit();
  setTimeout(() => {
    flying = flying.filter((f) => f.key !== entry.key);
    emit();
  }, REACTION_FLIGHT_MS);
}

// Flings `reaction` for everyone in the lobby. It's drawn locally straight
// away; `me`'s own echo from the server is then skipped (see
// lib/realtimeSocket.ts), so a tap feels instant.
export function flingGameReaction(
  lobbyId: number,
  meId: number,
  reaction: GameReaction,
): void {
  noteGameReaction(lobbyId, meId, reaction);
  sendGameReaction(lobbyId, reaction);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFlyingReactions(): ReadonlyArray<FlyingReaction> {
  return useSyncExternalStore(
    subscribe,
    () => flying,
    () => flying,
  );
}
