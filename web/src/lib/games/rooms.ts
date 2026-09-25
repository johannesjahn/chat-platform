import { useEffect, useSyncExternalStore } from "react";

// Bridges the games UI to the single `/ws` connection owned by
// `useRealtimeSocket` — the named-room counterpart of lib/postRooms.ts. A
// page viewing a lobby (or the lobby browser) joins that room with a
// `subscribe_room` control message (see src/RealtimeSocket.ts), so it gets the
// lobby's `game_lobby_updated`/`game_progress` events without every other
// connected client getting them too. Membership is ref-counted per room and
// replayed whenever the socket (re)connects.

let currentSocket: WebSocket | null = null;
// room -> number of live subscribers on this client.
const desired = new Map<string, number>();

function send(message: Record<string, unknown>): void {
  if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
    currentSocket.send(JSON.stringify(message));
  }
}

// Called by `useRealtimeSocket` with the live socket on open and null on
// close. The previous socket's server-side room membership died with it, so
// every room still wanted is re-joined.
export function setGameRoomsSocket(socket: WebSocket | null): void {
  currentSocket = socket;
  if (socket) {
    for (const room of desired.keys()) send({ type: "subscribe_room", room });
  }
}

function acquire(room: string): () => void {
  const count = desired.get(room) ?? 0;
  desired.set(room, count + 1);
  if (count === 0) send({ type: "subscribe_room", room });
  return () => {
    const current = desired.get(room) ?? 0;
    if (current <= 1) {
      desired.delete(room);
      send({ type: "unsubscribe_room", room });
    } else {
      desired.set(room, current - 1);
    }
  };
}

export const gameLobbyRoom = (lobbyId: number) => `game-lobby:${lobbyId}`;
export const gameHubRoom = (game: string) => `game-hub:${game}`;

// Stay in `room` for as long as the calling component is mounted.
export function useGameRoom(room: string | null): void {
  useEffect(() => {
    if (!room) return;
    return acquire(room);
  }, [room]);
}

// Streams this client's race position to everyone in the lobby's room. The
// server stamps the sender's identity and relays it (never stores or scores
// it — see GameProgressEvent in src/Realtime.ts).
export function sendGameProgress(lobbyId: number, progress: number): void {
  send({ type: "game_progress", lobbyId, progress });
}

// Live opponent positions, fed by `game_progress` events. A tiny external
// store (like lib/presence.ts) rather than React Query: this is transient
// socket state with no REST resource behind it.
type ProgressKey = `${number}:${number}`;
const progress = new Map<ProgressKey, number>();
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
  version++;
  for (const listener of listeners) listener();
}

export function resetGameProgress(lobbyId: number): void {
  for (const key of progress.keys()) {
    if (key.startsWith(`${lobbyId}:`)) progress.delete(key);
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
