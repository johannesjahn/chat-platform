import { RedisClient } from "bun";
import { Context, Effect, Layer } from "effect";

// Result of attempting to consume one unit from a fixed-window rate-limit
// bucket identified by some key (an IP, an account, ...).
export interface RateLimitResult {
  readonly allowed: boolean;
  // Seconds until the bucket's window resets — meaningful whether or not
  // this attempt was allowed, so callers can surface a "try again in Ns"
  // hint even on the attempt that trips the limit.
  readonly retryAfterSeconds: number;
}

// Fixed-window rate limiting: `key` identifies a bucket that allows up to
// `limit` calls within any `windowSeconds` period before further calls are
// rejected until the window rolls over.
export class RateLimiter extends Context.Service<
  RateLimiter,
  {
    readonly consume: (
      key: string,
      limit: number,
      windowSeconds: number,
    ) => Effect.Effect<RateLimitResult>;
    // Gives back one unit previously taken from `key` by `consume`, never
    // going below zero and leaving the window's expiry untouched (a missing
    // or expired bucket is a no-op). For buckets that should only count some
    // outcomes (e.g. failed logins): consume atomically up front, so
    // concurrent calls can't all slip past a check, then refund once the
    // outcome turns out not to count.
    readonly refund: (key: string) => Effect.Effect<void>;
    // Drops `key`'s bucket entirely, as if its window had just rolled over.
    readonly reset: (key: string) => Effect.Effect<void>;
  }
>()("RateLimiter") {}

// Single-process fixed-window counters. Like InMemoryPubSubLive (see
// PubSub.ts), this is fully correct only when there's a single app instance —
// each instance would otherwise enforce its own separate limit. Buckets are
// reset lazily the first time they're touched after expiring (rather than
// swept on a timer), so memory use is bounded by the number of distinct keys
// seen within the current window, not by process uptime.
export const InMemoryRateLimiterLive = Layer.sync(RateLimiter, () => {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    consume: (key, limit, windowSeconds) =>
      Effect.sync(() => {
        const now = Date.now();
        const existing = buckets.get(key);
        const bucket =
          existing && existing.resetAt > now
            ? existing
            : { count: 0, resetAt: now + windowSeconds * 1000 };
        bucket.count += 1;
        buckets.set(key, bucket);
        return {
          allowed: bucket.count <= limit,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((bucket.resetAt - now) / 1000),
          ),
        };
      }),
    refund: (key) =>
      Effect.sync(() => {
        const existing = buckets.get(key);
        if (existing && existing.resetAt > Date.now()) {
          existing.count = Math.max(0, existing.count - 1);
        }
      }),
    reset: (key) =>
      Effect.sync(() => {
        buckets.delete(key);
      }),
  };
});

// Redis-backed fixed-window counters via INCR + EXPIRE, so every
// horizontally-scaled app instance enforces the same limit (mirrors
// RedisPubSubLive in PubSub.ts). INCR on a fresh key both creates it and
// returns 1, so only that first call needs to also set the TTL. There's a
// narrow race between the INCR and the following EXPIRE (a crash in between
// would leave a key that never expires) — acceptable here, since the only
// consequence is a rate limit occasionally staying stricter than intended,
// not a correctness issue.
// Atomic floor-at-zero decrement for `refund`. DECR keeps the key's TTL, and
// a missing key is left alone rather than recreated (which DECR on its own
// would do, as -1 with no expiry).
const REFUND_SCRIPT = `
local count = tonumber(redis.call("GET", KEYS[1]))
if count and count > 0 then
  return redis.call("DECR", KEYS[1])
end
return 0
`;

export const RedisRateLimiterLive = Layer.sync(RateLimiter, () => {
  const client = new RedisClient(process.env.REDIS_URL);

  return {
    consume: (key, limit, windowSeconds) =>
      Effect.promise(async () => {
        const redisKey = `ratelimit:${key}`;
        const count = await client.incr(redisKey);
        if (count === 1) {
          await client.expire(redisKey, windowSeconds);
        }
        const ttl = await client.ttl(redisKey);
        return {
          allowed: count <= limit,
          retryAfterSeconds: ttl > 0 ? ttl : windowSeconds,
        };
      }),
    refund: (key) =>
      Effect.promise(async () => {
        await client.send("EVAL", [REFUND_SCRIPT, "1", `ratelimit:${key}`]);
      }),
    reset: (key) =>
      Effect.promise(async () => {
        await client.del(`ratelimit:${key}`);
      }),
  };
});

// `REDIS_URL` unset — the default for local `bun run dev`/`bun test` — falls
// back to the in-memory implementation above, same rationale as PubSubLive.
export const RateLimiterLive = process.env.REDIS_URL
  ? RedisRateLimiterLive
  : InMemoryRateLimiterLive;
