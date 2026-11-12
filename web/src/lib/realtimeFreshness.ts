// How long the queries the realtime socket keeps current may go without a
// refetch on mount (issue #752). Its own module, with no imports, so the
// rules are unit-testable on their own.
//
// The chat lists, the unread totals and a game's lobby list are refreshed
// by realtime events (`chat_updated`, `notifications_changed`,
// `game_lobbies_changed` — see realtimeSocket.ts), and every (re)connect
// invalidates all of them. While that holds, mounting one shouldn't
// refetch it. But it only holds while it's true *now*: with the socket
// down, or for a room this client isn't in, nothing would ever tell the
// cache it changed — so data counts as fresh only if the socket (and the
// room, where the data's events come through one) has been live since
// before the data arrived, and for no longer than `REALTIME_STALE_TIME_MS`.
// Anything else falls back to React Query's default `staleTime` of 0: a
// mount refetches, exactly as it did before.

// The cap, even while covered: events are best-effort, a half-open socket
// can look open until its next ping fails, and a few things listed (a
// lobby going idle and dropping off the list) change with no event at all.
export const REALTIME_STALE_TIME_MS = 2 * 60_000;

// Not realtime-backed: user summaries (`GET /users/:id`) change rarely, and
// the user's own edits invalidate them.
export const USER_SUMMARY_STALE_TIME_MS = 5 * 60_000;

// When the current socket opened, or null while there's none.
let socketOpenedAt: number | null = null;
// Room -> when it was joined on the current socket.
const roomJoinedAt = new Map<string, number>();

// Called by `useRealtimeSocket` as a socket opens — before the rooms are
// replayed onto it and before the (re)connect invalidation.
export function noteSocketOpened(at: number = Date.now()): void {
  socketOpenedAt = at;
  roomJoinedAt.clear();
}

// As the socket closes (or is torn down): nothing is covered until the
// next one opens, and the rooms died with it.
export function noteSocketClosed(): void {
  socketOpenedAt = null;
  roomJoinedAt.clear();
}

// Called by games/rooms.ts once `subscribe_room` has actually gone out on
// the open socket (not merely been wanted).
export function noteRoomJoined(room: string, at: number = Date.now()): void {
  if (socketOpenedAt === null) return;
  roomJoinedAt.set(room, at);
}

export function noteRoomLeft(room: string): void {
  roomJoinedAt.delete(room);
}

// Whether data that arrived at `dataUpdatedAt` has had the socket (and
// `room`, if given) live ever since — so any change since would have
// invalidated it.
export function isCoveredByRealtime(
  dataUpdatedAt: number,
  room?: string,
): boolean {
  if (socketOpenedAt === null || socketOpenedAt > dataUpdatedAt) return false;
  if (room === undefined) return true;
  const joinedAt = roomJoinedAt.get(room);
  return joinedAt !== undefined && joinedAt <= dataUpdatedAt;
}

// The part of a `Query` this reads — structural, like routeLoader.ts's.
type StaleQuery = { state: { dataUpdatedAt: number } };

// A `staleTime` for a query kept current by the socket (and, for a query
// whose events come through a room, that room). A function, so it's
// decided each time React Query asks — at mount, on focus — against the
// socket as it is then. It composes with `refetchOnMount:
// refetchUnlessWarmed`: that returns `true` ("refetch if stale"), not
// `"always"`, so this decides what's stale.
export function realtimeStaleTime(room?: string) {
  return (query: StaleQuery): number =>
    isCoveredByRealtime(query.state.dataUpdatedAt, room)
      ? REALTIME_STALE_TIME_MS
      : 0;
}
