/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  PING_INTERVAL_MS,
  RECONNECT_BASE_MS,
  type RealtimeLinkEvents,
  startRealtimeConnection,
} from "./realtimeConnection";

type FakeSocket = {
  ticket: string;
  events: RealtimeLinkEvents;
  sent: string[];
  closed: boolean;
  send: (data: string) => void;
  close: () => void;
};

// A hand-driven world: timers fire only on `advance`, tickets resolve only
// on `resolveTicket`, and connectivity flips only on `goOffline`/`goOnline`.
function harness({ startOnline = true }: { startOnline?: boolean } = {}) {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<
    number,
    { at: number; callback: () => void; every?: number }
  >();
  let online = startOnline;
  const onlineListeners = new Set<() => void>();
  const ticketRequests: Array<(ticket: string | null) => void> = [];
  const sockets: FakeSocket[] = [];
  const log: string[] = [];

  const asTimer = (id: number) =>
    id as unknown as ReturnType<typeof setTimeout>;
  const fromTimer = (timer: ReturnType<typeof setTimeout>) =>
    timer as unknown as number;

  const stop = startRealtimeConnection<FakeSocket>({
    isOnline: () => online,
    subscribeOnline: (listener) => {
      onlineListeners.add(listener);
      return () => onlineListeners.delete(listener);
    },
    fetchTicket: () =>
      new Promise((resolve, reject) => {
        log.push("ticket");
        // Like a real fetch: one sent while offline fails.
        if (!online) return reject(new TypeError("Failed to fetch"));
        ticketRequests.push(resolve);
      }),
    openSocket: (ticket, events) => {
      log.push(`socket ${ticket}`);
      const socket: FakeSocket = {
        ticket,
        events,
        sent: [],
        closed: false,
        send: (data) => socket.sent.push(data),
        close: () => {
          if (socket.closed) return;
          socket.closed = true;
          events.close();
        },
      };
      sockets.push(socket);
      return socket;
    },
    onOpen: (socket) => log.push(`open ${socket.ticket}`),
    onMessage: (data) => log.push(`message ${String(data)}`),
    onClose: () => log.push("closed"),
    setTimeout: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, callback });
      return asTimer(id);
    },
    clearTimeout: (timer) => void timers.delete(fromTimer(timer)),
    setInterval: (callback, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, callback, every: ms });
      return asTimer(id);
    },
    clearInterval: (timer) => void timers.delete(fromTimer(timer)),
    // Always the full backoff, so delays are predictable.
    random: () => 1,
  });

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  return {
    log,
    sockets,
    stop,
    pendingTimers: () => [...timers.values()].filter((t) => !t.every).length,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= until)
          .sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every) timer.at += timer.every;
        else timers.delete(id);
        timer.callback();
        await flush();
      }
      now = until;
    },
    async resolveTicket(ticket: string | null) {
      const resolve = ticketRequests.shift();
      if (!resolve) throw new Error("no ticket request pending");
      resolve(ticket);
      await flush();
    },
    pendingTicketRequests: () => ticketRequests.length,
    goOffline() {
      online = false;
    },
    async goOnline() {
      online = true;
      onlineListeners.forEach((listener) => listener());
      await flush();
    },
    onlineListenerCount: () => onlineListeners.size,
    flush,
  };
}

describe("startRealtimeConnection", () => {
  test("connects with a ticket, reports the socket's events, and pings", async () => {
    const h = harness();
    expect(h.log).toEqual(["ticket"]);
    await h.resolveTicket("t1");
    h.sockets[0]!.events.open();
    h.sockets[0]!.events.message("hello");
    expect(h.log).toEqual(["ticket", "socket t1", "open t1", "message hello"]);

    await h.advance(PING_INTERVAL_MS);
    expect(h.sockets[0]!.sent).toEqual(["ping"]);
    h.stop();
  });

  test("reconnects with backoff after a close while online", async () => {
    const h = harness();
    await h.resolveTicket("t1");
    h.sockets[0]!.events.open();
    h.sockets[0]!.events.close();
    expect(h.log.at(-1)).toBe("closed");

    await h.advance(RECONNECT_BASE_MS - 1);
    expect(h.pendingTicketRequests()).toBe(0);
    await h.advance(1);
    expect(h.pendingTicketRequests()).toBe(1);
    h.stop();
  });

  test("doesn't attempt anything while offline from the start, and connects as soon as it's back", async () => {
    const h = harness({ startOnline: false });
    expect(h.log).toEqual([]);
    await h.advance(60_000);
    expect(h.log).toEqual([]);
    expect(h.pendingTimers()).toBe(0);

    await h.goOnline();
    expect(h.log).toEqual(["ticket"]);
    await h.resolveTicket("t1");
    expect(h.sockets).toHaveLength(1);
    h.stop();
  });

  test("a socket that closes while offline waits for `online` instead of retrying on a timer", async () => {
    const h = harness();
    await h.resolveTicket("t1");
    h.sockets[0]!.events.open();

    h.goOffline();
    h.sockets[0]!.events.close();
    expect(h.log.at(-1)).toBe("closed");
    expect(h.pendingTimers()).toBe(0);
    await h.advance(60_000);
    expect(h.log.filter((entry) => entry === "ticket")).toHaveLength(1);

    await h.goOnline();
    expect(h.log.filter((entry) => entry === "ticket")).toHaveLength(2);
    await h.resolveTicket("t2");
    expect(h.sockets).toHaveLength(2);
    h.stop();
  });

  test("connectivity dropping while the ticket is in flight opens no socket", async () => {
    const h = harness();
    h.goOffline();
    await h.resolveTicket("t1");
    expect(h.sockets).toHaveLength(0);
    expect(h.pendingTimers()).toBe(0);

    await h.goOnline();
    await h.resolveTicket("t2");
    expect(h.sockets.map((socket) => socket.ticket)).toEqual(["t2"]);
    h.stop();
  });

  test("a backoff timer that fires while offline doesn't try, and `online` connects with the backoff reset", async () => {
    const h = harness();
    // Three failed tickets grow the backoff to 8s.
    await h.resolveTicket(null);
    await h.advance(RECONNECT_BASE_MS);
    await h.resolveTicket(null);
    await h.advance(RECONNECT_BASE_MS * 2);
    await h.resolveTicket(null);
    expect(h.pendingTimers()).toBe(1);

    h.goOffline();
    await h.advance(RECONNECT_BASE_MS * 4);
    expect(h.log.filter((entry) => entry === "ticket")).toHaveLength(3);

    await h.goOnline();
    expect(h.log.filter((entry) => entry === "ticket")).toHaveLength(4);
    await h.resolveTicket("t1");
    h.sockets[0]!.events.close();
    // Back to the base delay, not the grown one.
    await h.advance(RECONNECT_BASE_MS);
    expect(h.log.filter((entry) => entry === "ticket")).toHaveLength(5);
    h.stop();
  });

  test("`online` during a backoff cuts it short", async () => {
    const h = harness();
    await h.resolveTicket(null);
    expect(h.pendingTimers()).toBe(1);
    await h.goOnline();
    expect(h.pendingTimers()).toBe(0);
    expect(h.pendingTicketRequests()).toBe(1);
    h.stop();
  });

  test("`online` leaves an open socket or a ticket in flight alone", async () => {
    const h = harness();
    await h.goOnline();
    expect(h.pendingTicketRequests()).toBe(1);
    await h.resolveTicket("t1");
    h.sockets[0]!.events.open();
    await h.goOnline();
    expect(h.sockets).toHaveLength(1);
    expect(h.pendingTicketRequests()).toBe(0);
    h.stop();
  });

  test("stopping closes the socket without reporting it, and stops listening", async () => {
    const h = harness();
    await h.resolveTicket("t1");
    h.sockets[0]!.events.open();
    h.stop();
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.log).not.toContain("closed");
    expect(h.onlineListenerCount()).toBe(0);
    expect(h.pendingTimers()).toBe(0);
  });

  test("a ticket that arrives after stopping opens nothing", async () => {
    const h = harness();
    h.stop();
    await h.resolveTicket("t1");
    expect(h.sockets).toHaveLength(0);
  });
});
