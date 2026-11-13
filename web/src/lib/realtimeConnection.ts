// The realtime socket's connection lifecycle — ticket, open, ping, backoff,
// and waiting out a lost connection (issue #807) — kept apart from what the
// socket's events *do* (realtimeSocket.ts), with everything it touches in
// the browser passed in, so the rules are unit-testable on their own.
//
// While the browser reports itself offline (`navigator.onLine === false`,
// which unlike `true` is reliable: the browser won't even try the network)
// nothing is attempted at all — not a ticket, not a socket, not a timer.
// Opening a WebSocket then only logs a native `ERR_INTERNET_DISCONNECTED`
// error and burns a backoff step. It waits for the `online` event instead,
// then connects straight away with the backoff reset. An `online` event
// during an ordinary backoff (the server was unreachable) also cuts the
// wait short. A socket already open is left alone either way: going offline
// eventually closes it, and that close is what starts the wait.

// A little more than the default Bun WebSocket idle timeout — sending
// anything at all (the content is irrelevant, the server ignores incoming
// messages) resets it, so this alone keeps the connection from being closed
// as idle during a quiet conversation.
export const PING_INTERVAL_MS = 30_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 15_000;

export type RealtimeLink = {
  send: (data: string) => void;
  close: () => void;
};

export type RealtimeLinkEvents = {
  open: () => void;
  message: (data: unknown) => void;
  close: () => void;
};

type Timer = ReturnType<typeof setTimeout>;

export type RealtimeConnectionDeps<S extends RealtimeLink> = {
  // Whether the browser says it can reach the network at all.
  isOnline: () => boolean;
  // Calls `listener` on every `online` event; returns the unsubscribe.
  subscribeOnline: (listener: () => void) => () => void;
  // A ticket for `/ws`, or null if minting one failed (it may also reject).
  fetchTicket: () => Promise<string | null>;
  // Opens the socket, reporting its events through `events`.
  openSocket: (ticket: string, events: RealtimeLinkEvents) => S;
  // Each time a socket opens.
  onOpen: (socket: S) => void;
  onMessage: (data: unknown) => void;
  // Each time an open (or opening) socket closes, unless stopped.
  onClose: () => void;
  setTimeout?: (callback: () => void, ms: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  setInterval?: (callback: () => void, ms: number) => Timer;
  clearInterval?: (timer: Timer) => void;
  random?: () => number;
};

// Starts connecting (now, or once online) and keeps reconnecting until the
// returned function stops it. Stopping closes the socket without calling
// `onClose` — the caller tears down its own state.
export function startRealtimeConnection<S extends RealtimeLink>(
  deps: RealtimeConnectionDeps<S>,
): () => void {
  const {
    setTimeout: setTimer = (callback, ms) => setTimeout(callback, ms),
    clearTimeout: clearTimer = (timer) => clearTimeout(timer),
    setInterval: setRepeating = (callback, ms) => setInterval(callback, ms),
    clearInterval: clearRepeating = (timer) => clearInterval(timer),
    random = Math.random,
  } = deps;

  let socket: S | null = null;
  let pingTimer: Timer | undefined;
  let reconnectTimer: Timer | undefined;
  let reconnectDelay = RECONNECT_BASE_MS;
  // A ticket request is in flight; whatever it ends in decides what's next.
  let fetchingTicket = false;
  let stopped = false;

  function scheduleReconnect() {
    // Offline: nothing to retry until the `online` event (below).
    if (!deps.isOnline()) return;
    // Wait a random half-to-all of the backoff, so a deploy (which drops every
    // client at once) doesn't bring them all back in lockstep.
    const delay = reconnectDelay / 2 + random() * (reconnectDelay / 2);
    reconnectTimer = setTimer(() => {
      reconnectTimer = undefined;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      void connect();
    }, delay);
  }

  async function connect() {
    if (!deps.isOnline()) return;
    fetchingTicket = true;
    // A network failure (offline, server unreachable) rejects rather than
    // returning null; it gets the same backoff — left to reject, it surfaced
    // as an unhandled rejection and ended the reconnect loop (issue #618).
    const ticket = await deps.fetchTicket().catch(() => null);
    fetchingTicket = false;
    if (stopped) return;
    if (ticket === null) {
      scheduleReconnect();
      return;
    }
    // Connectivity dropped while the ticket was on its way: the socket
    // would only fail. Tickets are single-use and short-lived, so this one
    // is simply dropped and a fresh one minted once back online.
    if (!deps.isOnline()) return;

    const opened: S = deps.openSocket(ticket, {
      open: () => {
        if (stopped || socket !== opened) return;
        reconnectDelay = RECONNECT_BASE_MS;
        pingTimer = setRepeating(() => opened.send("ping"), PING_INTERVAL_MS);
        deps.onOpen(opened);
      },
      message: (data) => {
        if (stopped || socket !== opened) return;
        deps.onMessage(data);
      },
      close: () => {
        if (socket !== opened) return;
        socket = null;
        if (pingTimer !== undefined) clearRepeating(pingTimer);
        pingTimer = undefined;
        if (stopped) return;
        deps.onClose();
        scheduleReconnect();
      },
    });
    socket = opened;
  }

  const unsubscribeOnline = deps.subscribeOnline(() => {
    // Only when idle — waiting for connectivity, or backing off. A ticket
    // request in flight or a socket open (or opening) carries on.
    if (stopped || fetchingTicket || socket) return;
    if (reconnectTimer !== undefined) clearTimer(reconnectTimer);
    reconnectTimer = undefined;
    reconnectDelay = RECONNECT_BASE_MS;
    void connect();
  });

  void connect();

  return () => {
    stopped = true;
    unsubscribeOnline();
    if (pingTimer !== undefined) clearRepeating(pingTimer);
    if (reconnectTimer !== undefined) clearTimer(reconnectTimer);
    socket?.close();
  };
}
