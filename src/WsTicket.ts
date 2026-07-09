import { RedisClient } from "bun";
import { Context, Effect, Layer } from "effect";

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
export class WsTicket extends Context.Tag("WsTicket")<
  WsTicket,
  {
    readonly issue: (userId: number) => Effect.Effect<string>;
    // Redeems `ticket`, returning the userId it was issued for, or `null` if
    // it's missing, expired, or already consumed. Always deletes the ticket
    // as part of looking it up, so a captured/replayed ticket — or two racing
    // `/ws` upgrades presenting the same one — can succeed at most once.
    readonly consume: (ticket: string) => Effect.Effect<number | null>;
  }
>() {}

// Single-process ticket store. Like InMemoryPubSubLive (see PubSub.ts), only
// correct when there's a single app instance — a ticket minted on one
// instance wouldn't be redeemable on another. Expired entries are dropped
// lazily on the next `consume` that happens to touch them rather than swept
// on a timer, so memory use is bounded by tickets actually issued within the
// last TICKET_TTL_SECONDS.
export const InMemoryWsTicketLive = Layer.sync(WsTicket, () => {
  const tickets = new Map<string, { userId: number; expiresAt: number }>();

  return {
    issue: (userId) =>
      Effect.sync(() => {
        const ticket = crypto.randomUUID();
        tickets.set(ticket, {
          userId,
          expiresAt: Date.now() + TICKET_TTL_SECONDS * 1000,
        });
        return ticket;
      }),
    consume: (ticket) =>
      Effect.sync(() => {
        const entry = tickets.get(ticket);
        tickets.delete(ticket);
        if (!entry || entry.expiresAt < Date.now()) return null;
        return entry.userId;
      }),
  };
});

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
