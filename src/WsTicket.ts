import { Config, Context, Effect, Layer } from "effect";
import { IN_MEMORY_SWEEP_INTERVAL_MS } from "./RateLimiter.ts";
import {
  redisFallback,
  type SupervisedRedis,
  supervisedRedis,
} from "./redisConnection.ts";

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

// Tickets issued while Redis is unreachable (issue #832). The upgrade
// usually lands on a different instance than the one that minted the
// ticket, so a fallback ticket can't be a random id only its issuer knows:
// it carries the user id and expiry, signed with a key derived from
// JWT_SECRET, and any instance can check it — `f1.<userId>.<expiresAtMs>.
// <nonce>.<signature>`. Still single-use: its nonce is claimed in Redis if
// Redis is back by the time it's redeemed, and otherwise on the redeeming
// instance, so during an outage a captured ticket could be replayed once
// per *other* instance within its 30 seconds — the cost of letting
// sockets connect at all while Redis is down.
const FALLBACK_PREFIX = "f1.";

const base64url = (bytes: ArrayBuffer) =>
  Buffer.from(bytes).toString("base64url");

export const makeFallbackTickets = async (jwtSecret: string) => {
  const hmacKey = (raw: ArrayBuffer | Uint8Array<ArrayBuffer>) =>
    crypto.subtle.importKey(
      "raw",
      raw,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  // A key of its own, so a ticket signature can never stand in for a JWT's.
  const key = await hmacKey(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(new TextEncoder().encode(jwtSecret)),
      new TextEncoder().encode("chat-platform:ws-ticket-fallback"),
    ),
  );
  const sign = async (payload: string) =>
    base64url(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
    );

  return {
    issue: async (userId: number, now = Date.now()) => {
      const payload = `${FALLBACK_PREFIX}${userId}.${now + TICKET_TTL_SECONDS * 1000}.${crypto.randomUUID()}`;
      return `${payload}.${await sign(payload)}`;
    },
    // The user id and nonce of a well-formed, correctly signed, unexpired
    // fallback ticket, or null.
    verify: async (
      ticket: string,
      now = Date.now(),
    ): Promise<{ userId: number; nonce: string } | null> => {
      if (!ticket.startsWith(FALLBACK_PREFIX)) return null;
      const parts = ticket.slice(FALLBACK_PREFIX.length).split(".");
      if (parts.length !== 4) return null;
      const [user, expires, nonce, signature] = parts as [
        string,
        string,
        string,
        string,
      ];
      const userId = Number(user);
      const expiresAt = Number(expires);
      if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(expiresAt))
        return null;
      const given = new Uint8Array(Buffer.from(signature, "base64url"));
      const valid = await crypto.subtle.verify(
        "HMAC",
        key,
        given,
        new TextEncoder().encode(
          `${FALLBACK_PREFIX}${user}.${expires}.${nonce}`,
        ),
      );
      if (!valid || expiresAt < now) return null;
      return { userId, nonce };
    },
  };
};

// Redis-backed ticket store, so a ticket minted on one horizontally-scaled
// instance can be redeemed by the `/ws` upgrade landing on any other
// (mirrors RedisPubSubLive/RedisRateLimiterLive). `GETDEL` is Redis's atomic
// get-and-delete — exactly the single-use semantics `consume` needs, with no
// separate round trip (and no race) between reading the value and expiring
// it. While Redis is down, tickets are the signed kind above.
export const makeRedisWsTicket = (
  redis: SupervisedRedis,
  fallback: Awaited<ReturnType<typeof makeFallbackTickets>>,
): WsTicket["Service"] => {
  const { client } = redis;
  const key = (ticket: string) => `ws-ticket:${ticket}`;
  // Nonces of fallback tickets redeemed here while Redis was down; a used
  // ticket is expired within TICKET_TTL_SECONDS, so that's how long one is
  // kept.
  const usedLocally = new Map<string, number>();
  const claimLocally = (nonce: string, now: number) => {
    for (const [used, until] of usedLocally) {
      if (until < now) usedLocally.delete(used);
    }
    if (usedLocally.has(nonce)) return false;
    usedLocally.set(nonce, now + TICKET_TTL_SECONDS * 1000);
    return true;
  };

  return {
    issue: (userId) =>
      Effect.tryPromise(async () => {
        const ticket = crypto.randomUUID();
        await client.set(key(ticket), String(userId), "EX", TICKET_TTL_SECONDS);
        return ticket;
      }).pipe(
        Effect.catch((error) =>
          redisFallback(redis, "ws-ticket", "issue", error).pipe(
            Effect.andThen(Effect.promise(() => fallback.issue(userId))),
          ),
        ),
      ),
    consume: (ticket) =>
      Effect.gen(function* () {
        if (ticket.startsWith(FALLBACK_PREFIX)) {
          const signed = yield* Effect.promise(() => fallback.verify(ticket));
          if (!signed) return null;
          const claimed = yield* Effect.tryPromise(() =>
            client.send("SET", [
              `ws-ticket-used:${signed.nonce}`,
              "1",
              "EX",
              String(TICKET_TTL_SECONDS),
              "NX",
            ]),
          ).pipe(
            Effect.map((reply) => reply === "OK"),
            Effect.catch((error) =>
              redisFallback(redis, "ws-ticket", "consume", error).pipe(
                Effect.as(claimLocally(signed.nonce, Date.now())),
              ),
            ),
          );
          return claimed ? signed.userId : null;
        }
        // A ticket from Redis can't be redeemed without it: the client
        // fetches a new one, which is then the signed kind.
        return yield* Effect.tryPromise(() => client.getdel(key(ticket))).pipe(
          Effect.map((value) => (value === null ? null : Number(value))),
          Effect.catch((error) =>
            redisFallback(redis, "ws-ticket", "consume", error).pipe(
              Effect.as(null),
            ),
          ),
        );
      }),
  };
};

export const RedisWsTicketLive = Layer.effect(
  WsTicket,
  Effect.gen(function* () {
    const secret = yield* Config.String("JWT_SECRET");
    const fallback = yield* Effect.promise(() => makeFallbackTickets(secret));
    const redis = supervisedRedis("ws-ticket");
    yield* Effect.promise(() => redis.ready);
    return makeRedisWsTicket(redis, fallback);
  }),
);

// `REDIS_URL` unset — the default for local `bun run dev`/`bun test` — falls
// back to the in-memory implementation above, same rationale as PubSubLive.
export const WsTicketLive = process.env.REDIS_URL
  ? RedisWsTicketLive
  : InMemoryWsTicketLive;
