import { RedisClient } from "bun";
import { Context, Effect, Layer } from "effect";
import { IN_MEMORY_SWEEP_INTERVAL_MS } from "./RateLimiter.ts";

// Long enough to cover minting a ticket over REST and immediately opening
// the `/ws` connection with it, short enough that a leaked ticket (e.g. one
// that ends up in an access/proxy log despite the redaction in
// RedactedLogger.ts) is useless well before anyone could replay it — unlike
// the 15-minute access token it replaces in the `/ws` URL (see issue #26).
const TICKET_TTL_SECONDS = 30;

// Mints and redeems short-lived, single-use tickets that authenticate the
// `/ws` WebSocket upgrade without putting the long-lived bearer access token
// in a URL (query params routinely end up in server/proxy logs and browser
// history, unlike an `Authorization` header — which a browser `WebSocket`
// can't set on the handshake anyway). A client authenticates over normal
// REST with its access token to mint a ticket (see RealtimeHandler.ts), then
// passes *that* on the `/ws` URL instead.
export class WsTicket extends Context.Service<
  WsTicket,
  {
    readonly issue: (userId: number) => Effect.Effect<string>;
    // Redeems `ticket`, returning the userId it was issued for, or `null` if
    // it's missing, expired, or already consumed. Always deletes the ticket
    // as part of looking it up, so a captured/replayed ticket — or two racing
    // `/ws` upgrades presenting the same one — can succeed at most once.
    readonly consume: (ticket: string) => Effect.Effect<number | null>;
  }
>()("WsTicket") {}

// Single-process ticket store, plus its entry count (for tests). Like
// InMemoryPubSubLive (see PubSub.ts), only correct when there's a single app
// instance — a ticket minted on one instance wouldn't be redeemable on
// another. A redeemed ticket is deleted on the spot; one that's never
// redeemed (the tab closed before the upgrade, or the upgrade failed) is
// dropped by a sweep every IN_MEMORY_SWEEP_INTERVAL_MS, run opportunistically
// like the in-memory rate limiter's (issue #653). So memory is bounded by
// tickets issued within the last TICKET_TTL_SECONDS plus one sweep interval.
export const makeInMemoryWsTicket = () => {
  const tickets = new Map<string, { userId: number; expiresAt: number }>();
  let nextSweepAt = Date.now() + IN_MEMORY_SWEEP_INTERVAL_MS;

  const sweepIfDue = (now: number) => {
    if (now < nextSweepAt) return;
    nextSweepAt = now + IN_MEMORY_SWEEP_INTERVAL_MS;
    for (const [ticket, entry] of tickets) {
      if (entry.expiresAt < now) tickets.delete(ticket);
    }
  };

  const service: WsTicket["Service"] = {
    issue: (userId) =>
      Effect.sync(() => {
        const now = Date.now();
        sweepIfDue(now);
        const ticket = crypto.randomUUID();
        tickets.set(ticket, {
          userId,
          expiresAt: now + TICKET_TTL_SECONDS * 1000,
        });
        return ticket;
      }),
    consume: (ticket) =>
      Effect.sync(() => {
        const now = Date.now();
        sweepIfDue(now);
        const entry = tickets.get(ticket);
        tickets.delete(ticket);
        if (!entry || entry.expiresAt < now) return null;
        return entry.userId;
      }),
  };

  return { service, size: () => tickets.size };
};

export const InMemoryWsTicketLive = Layer.sync(
  WsTicket,
  () => makeInMemoryWsTicket().service,
);

// Redis-backed ticket store, so a ticket minted on one horizontally-scaled
// instance can be redeemed by the `/ws` upgrade landing on any other
// (mirrors RedisPubSubLive/RedisRateLimiterLive). `GETDEL` is Redis's atomic
// get-and-delete — exactly the single-use semantics `consume` needs, with no
// separate round trip (and no race) between reading the value and expiring
// it.
export const RedisWsTicketLive = Layer.sync(WsTicket, () => {
  const client = new RedisClient(process.env.REDIS_URL);
  const key = (ticket: string) => `ws-ticket:${ticket}`;

  return {
    issue: (userId) =>
      Effect.promise(async () => {
        const ticket = crypto.randomUUID();
        await client.set(key(ticket), String(userId), "EX", TICKET_TTL_SECONDS);
        return ticket;
      }),
    consume: (ticket) =>
      Effect.promise(async () => {
        const value = await client.getdel(key(ticket));
        return value === null ? null : Number(value);
      }),
  };
});

// `REDIS_URL` unset — the default for local `bun run dev`/`bun test` — falls
// back to the in-memory implementation above, same rationale as PubSubLive.
export const WsTicketLive = process.env.REDIS_URL
  ? RedisWsTicketLive
  : InMemoryWsTicketLive;
