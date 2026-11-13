import { useEffect, useSyncExternalStore } from "react";
import {
  noteRoomJoined,
  noteRoomLeft,
  REALTIME_STALE_TIME_MS,
} from "../realtimeFreshness";

// Bridges the games UI to the single `/ws` connection owned by
// `useRealtimeSocket` — the named-room counterpart of lib/postRooms.ts. A
// page viewing a lobby (or the lobby browser) joins that room with a
// `subscribe_room` control message (see src/RealtimeSocket.ts), so it gets the
// lobby's `game_lobby_updated`/`game_progress`/`game_chat`/`game_reaction`
// events without every other connected client getting them too. Membership is ref-counted per room and
// replayed whenever the socket (re)connects.

let currentSocket: WebSocket | null = null;
// room -> number of live subscribers on this client. A lingering room (see
// `acquireGameRoom`) stays here at 0, so a reconnect still re-joins it.
const desired = new Map<string, number>();
// room -> the timer that leaves a lingering room.
const lingering = new Map<string, ReturnType<typeof setTimeout>>();

function send(message: Record<string, unknown>): boolean {
  if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
    currentSocket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function join(room: string): void {
  if (send({ type: "subscribe_room", room })) noteRoomJoined(room);
}

function leave(room: string): void {
  desired.delete(room);
  noteRoomLeft(room);
  send({ type: "unsubscribe_room", room });
}

// Called by `useRealtimeSocket` with the live socket on open and null on
// close. The previous socket's server-side room membership died with it, so
// every room still wanted is re-joined.
export function setGameRoomsSocket(socket: WebSocket | null): void {
  currentSocket = socket;
  if (socket) {
    for (const room of desired.keys()) join(room);
  }
}

// `lingerMs` keeps the room joined that much longer after its last
// subscriber leaves — so its events keep invalidating what was fetched
// under it, and a page coming back within that time finds the data still
// covered (see realtimeFreshness.ts) instead of refetching it.
export function acquireGameRoom(room: string, lingerMs: number): () => void {
  const timer = lingering.get(room);
  if (timer !== undefined) {
    clearTimeout(timer);
    lingering.delete(room);
  }
  const count = desired.get(room);
  desired.set(room, (count ?? 0) + 1);
  if (count === undefined) join(room);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = desired.get(room) ?? 0;
    if (current > 1) {
      desired.set(room, current - 1);
    } else if (lingerMs > 0) {
      desired.set(room, 0);
      lingering.set(
        room,
        setTimeout(() => {
          lingering.delete(room);
          if (desired.get(room) === 0) leave(room);
        }, lingerMs),
      );
    } else {
      leave(room);
    }
  };
}

export const gameLobbyRoom = (lobbyId: number) => `game-lobby:${lobbyId}`;
export const gameHubRoom = (game: string) => `game-hub:${game}`;

// Stay in `room` for as long as the calling component is mounted.
export function useGameRoom(room: string | null): void {
  useEffect(() => {
    if (!room) return;
    return acquireGameRoom(room, 0);
  }, [room]);
}

// A game's lobby-browser room, for whatever shows its lobby list. Unlike a
// lobby's room (which streams every racer's progress) it's quiet — an
// id-only event per lobby change — so it's kept for as long as the list's
// `staleTime` relies on it after the page using it is gone (issue #752).
export function useGameHubRoom(game: string | null): void {
  useEffect(() => {
    if (!game) return;
    return acquireGameRoom(gameHubRoom(game), REALTIME_STALE_TIME_MS);
  }, [game]);
}

// Streams this client's race position to everyone in the lobby's room. The
// server stamps the sender's identity and relays it (never stores or scores
// it — see GameProgressEvent in src/Realtime.ts).
export function sendGameProgress(lobbyId: number, progress: number): void {
  send({ type: "game_progress", lobbyId, progress });
}

// Relays an emoji reaction to everyone in the lobby's room — stamped with
// the sender and never stored (see GameReactionEvent in src/Realtime.ts).
export function sendGameReaction(lobbyId: number, reaction: string): void {
  send({ type: "game_reaction", lobbyId, reaction });
}

// Live opponent positions, fed by `game_progress` events. A tiny external
// store (like lib/presence.ts) rather than React Query: this is transient
// socket state with no REST resource behind it.
type ProgressKey = `${number}:${number}`;
const progress = new Map<ProgressKey, number>();
// Every value each lane has moved through, in order — for a game whose
// frames each carry something of their own (a Reflex Rush round's result),
// not just the latest position.
const progressLog = new Map<ProgressKey, number[]>();
const listeners = new Set<() => void>();
let version = 0;

export function noteGameProgress(
  lobbyId: number,
  userId: number,
  value: number,
): void {
  const key: ProgressKey = `${lobbyId}:${userId}`;
  // Frames can overtake one another on the way in; a lane never slides back
  // except through `resetGameProgress` (a rematch).
  if ((progress.get(key) ?? -1) >= value) return;
  progress.set(key, value);
  progressLog.set(key, [...(progressLog.get(key) ?? []), value]);
  version++;
  for (const listener of listeners) listener();
}

export function resetGameProgress(lobbyId: number): void {
  for (const key of progress.keys()) {
    if (key.startsWith(`${lobbyId}:`)) progress.delete(key);
  }
  for (const key of progressLog.keys()) {
    if (key.startsWith(`${lobbyId}:`)) progressLog.delete(key);
  }
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Re-renders the caller whenever any tracked position changes; read values
// with `gameProgressOf`.
export function useGameProgressVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
}

export function gameProgressOf(lobbyId: number, userId: number): number {
  return progress.get(`${lobbyId}:${userId}`) ?? 0;
}

const NO_PROGRESS: ReadonlyArray<number> = [];

export function gameProgressLogOf(
  lobbyId: number,
  userId: number,
): ReadonlyArray<number> {
  return progressLog.get(`${lobbyId}:${userId}`) ?? NO_PROGRESS;
}
