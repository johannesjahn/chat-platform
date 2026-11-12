/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

// routeLoader.ts reads the session through ./auth; stubbed the same way as
// in routeLoader.test.ts (Bun's module mocks are shared across a run).
mock.module("./auth", () => ({
  getSession: () => null,
  setSession: () => {},
  clearSession: () => {},
  subscribeSession: () => () => {},
  useSession: () => null,
}));

const {
  REALTIME_STALE_TIME_MS,
  isCoveredByRealtime,
  noteRoomJoined,
  noteRoomLeft,
  noteSocketClosed,
  noteSocketOpened,
  realtimeStaleTime,
} = await import("./realtimeFreshness");
const { refetchUnlessWarmed } = await import("./routeLoader");
const { acquireGameRoom, setGameRoomsSocket } = await import("./games/rooms");

const ROOM = "game-hub:typing";

let realNow: () => number;
let now: number;

beforeEach(() => {
  noteSocketClosed();
  realNow = Date.now;
  now = 1_000_000;
  Date.now = () => now;
});

afterEach(() => {
  Date.now = realNow;
});

describe("isCoveredByRealtime", () => {
  test("nothing is covered without a socket", () => {
    expect(isCoveredByRealtime(now)).toBe(false);
  });

  test("data that arrived while the socket was open is covered", () => {
    noteSocketOpened(now);
    expect(isCoveredByRealtime(now)).toBe(true);
    expect(isCoveredByRealtime(now + 5)).toBe(true);
  });

  test("data from before the socket opened isn't", () => {
    noteSocketOpened(now);
    expect(isCoveredByRealtime(now - 1)).toBe(false);
  });

  test("closing the socket ends it, and a new socket doesn't cover what came before it", () => {
    noteSocketOpened(now);
    noteSocketClosed();
    expect(isCoveredByRealtime(now)).toBe(false);
    noteSocketOpened(now + 10);
    expect(isCoveredByRealtime(now)).toBe(false);
    expect(isCoveredByRealtime(now + 10)).toBe(true);
  });

  test("room data needs the room joined before it arrived", () => {
    noteSocketOpened(now);
    expect(isCoveredByRealtime(now, ROOM)).toBe(false);
    noteRoomJoined(ROOM, now + 1);
    expect(isCoveredByRealtime(now, ROOM)).toBe(false);
    expect(isCoveredByRealtime(now + 1, ROOM)).toBe(true);
    noteRoomLeft(ROOM);
    expect(isCoveredByRealtime(now + 1, ROOM)).toBe(false);
  });

  test("a room can't be joined without a socket, and dies with it", () => {
    noteRoomJoined(ROOM, now);
    noteSocketOpened(now);
    expect(isCoveredByRealtime(now, ROOM)).toBe(false);
    noteRoomJoined(ROOM, now);
    noteSocketClosed();
    noteSocketOpened(now);
    expect(isCoveredByRealtime(now, ROOM)).toBe(false);
  });
});

describe("realtimeStaleTime", () => {
  const query = (dataUpdatedAt: number) => ({ state: { dataUpdatedAt } });

  test("is the cap while covered, and 0 otherwise", () => {
    expect(realtimeStaleTime()(query(now))).toBe(0);
    noteSocketOpened(now);
    expect(realtimeStaleTime()(query(now))).toBe(REALTIME_STALE_TIME_MS);
    expect(realtimeStaleTime(ROOM)(query(now))).toBe(0);
  });
});

describe("with refetchOnMount: refetchUnlessWarmed", () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  // Mounts an observer the way `useQuery` does and reports whether that
  // mount sent a request.
  async function mountFetches(queryKey: readonly unknown[], room?: string) {
    const queryFn = mock(async () => "refetched");
    const observer = new QueryObserver(client, {
      queryKey,
      queryFn,
      refetchOnMount: refetchUnlessWarmed,
      staleTime: realtimeStaleTime(room),
    });
    const unsubscribe = observer.subscribe(() => {});
    await Promise.resolve();
    unsubscribe();
    return queryFn.mock.calls.length > 0;
  }

  test("a mount doesn't refetch covered data", async () => {
    noteSocketOpened(now);
    client.setQueryData(["covered"], "data");
    now += 60_000;
    expect(await mountFetches(["covered"])).toBe(false);
  });

  test("but does once the cap has passed", async () => {
    noteSocketOpened(now);
    client.setQueryData(["capped"], "data");
    now += REALTIME_STALE_TIME_MS;
    expect(await mountFetches(["capped"])).toBe(true);
  });

  test("a mount while the socket is down refetches", async () => {
    noteSocketOpened(now);
    client.setQueryData(["down"], "data");
    noteSocketClosed();
    expect(await mountFetches(["down"])).toBe(true);
  });

  test("an invalidation (an event, a reconnect) makes the next mount refetch", async () => {
    noteSocketOpened(now);
    client.setQueryData(["invalidated"], "data");
    await client.invalidateQueries({
      queryKey: ["invalidated"],
      refetchType: "none",
    });
    expect(await mountFetches(["invalidated"])).toBe(true);
  });

  test("room data refetches unless its room was joined", async () => {
    noteSocketOpened(now);
    client.setQueryData(["lobbies"], "data");
    expect(await mountFetches(["lobbies"], ROOM)).toBe(true);
    noteRoomJoined(ROOM, now);
    client.setQueryData(["lobbies"], "data again");
    expect(await mountFetches(["lobbies"], ROOM)).toBe(false);
  });
});

describe("acquireGameRoom", () => {
  // Stands in for the open `/ws` socket, recording what's sent on it.
  function fakeSocket() {
    const sent: unknown[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: (message: string) => sent.push(JSON.parse(message)),
    };
    return { socket: socket as unknown as WebSocket, sent };
  }

  let open: ReturnType<typeof fakeSocket>;
  beforeEach(() => {
    open = fakeSocket();
    noteSocketOpened(now);
    setGameRoomsSocket(open.socket);
  });
  afterEach(() => setGameRoomsSocket(null));

  test("joins on the first acquire and leaves on the last release", () => {
    const release = acquireGameRoom("game-lobby:1", 0);
    expect(open.sent).toEqual([
      { type: "subscribe_room", room: "game-lobby:1" },
    ]);
    expect(isCoveredByRealtime(now, "game-lobby:1")).toBe(true);
    release();
    expect(open.sent.at(-1)).toEqual({
      type: "unsubscribe_room",
      room: "game-lobby:1",
    });
    expect(isCoveredByRealtime(now, "game-lobby:1")).toBe(false);
  });

  test("a lingering room stays joined until its time is up", async () => {
    const release = acquireGameRoom("game-hub:linger", 20);
    release();
    expect(open.sent).toHaveLength(1);
    expect(isCoveredByRealtime(now, "game-hub:linger")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(open.sent.at(-1)).toEqual({
      type: "unsubscribe_room",
      room: "game-hub:linger",
    });
    expect(isCoveredByRealtime(now, "game-hub:linger")).toBe(false);
  });

  test("coming back while it lingers keeps it, without joining again", async () => {
    acquireGameRoom("game-hub:back", 20)();
    const release = acquireGameRoom("game-hub:back", 20);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(open.sent).toEqual([
      { type: "subscribe_room", room: "game-hub:back" },
    ]);
    expect(isCoveredByRealtime(now, "game-hub:back")).toBe(true);
    release();
  });

  test("a lingering room is re-joined on a new socket", () => {
    const release = acquireGameRoom("game-hub:rejoin", 60_000);
    release();
    noteSocketClosed();
    const next = fakeSocket();
    noteSocketOpened(now + 1);
    setGameRoomsSocket(next.socket);
    expect(next.sent).toContainEqual({
      type: "subscribe_room",
      room: "game-hub:rejoin",
    });
    expect(isCoveredByRealtime(now + 1, "game-hub:rejoin")).toBe(true);
    // Back for good, so the linger timer is cleared.
    acquireGameRoom("game-hub:rejoin", 0)();
  });
});
