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

// How often the in-memory stores below drop entries that have expired.
// Sweeping is opportunistic — the first call after this much time has passed
// runs it — so there's no timer to own or clean up, and an idle process
// simply keeps what it held until the next call.
export const IN_MEMORY_SWEEP_INTERVAL_MS = 60_000;

// Single-process fixed-window counters, plus the bucket count (for tests).
// Like InMemoryPubSubLive (see PubSub.ts), this is fully correct only when
// there's a single app instance — each instance would otherwise enforce its
// own separate limit. An expired bucket is replaced when its key is touched
// again, and every IN_MEMORY_SWEEP_INTERVAL_MS a sweep deletes the expired
// buckets nobody touched (issue #653: without it every IP and every typed
// username stayed in the map for the life of the process). So memory is
// bounded by the distinct keys seen within the longest window plus one sweep
// interval, not by process uptime.
export const makeInMemoryRateLimiter = () => {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let nextSweepAt = Date.now() + IN_MEMORY_SWEEP_INTERVAL_MS;

  const sweepIfDue = (now: number) => {
    if (now < nextSweepAt) return;
    nextSweepAt = now + IN_MEMORY_SWEEP_INTERVAL_MS;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  };

  const service: RateLimiter["Service"] = {
    consume: (key, limit, windowSeconds) =>
      Effect.sync(() => {
        const now = Date.now();
        sweepIfDue(now);
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

  return { service, size: () => buckets.size };
};

export const InMemoryRateLimiterLive = Layer.sync(
  RateLimiter,
  () => makeInMemoryRateLimiter().service,
);

// Redis-backed fixed-window counters, so every horizontally-scaled app
// instance enforces the same limit (mirrors RedisPubSubLive in PubSub.ts).
// One atomic script per call: INCR (creating the key at 1 if missing), then
// set the window's TTL whenever the key has none. Checking "no TTL" rather
// than "count is 1" is what makes it self-healing — a key left without an
// expiry (by an older INCR-then-EXPIRE that never finished its EXPIRE) gets
// one on its next consume instead of staying over its limit forever (issue
// #653). Returns `{count, ttl}`.
const CONSUME_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

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
        const [count, ttl] = (await client.send("EVAL", [
          CONSUME_SCRIPT,
          "1",
          `ratelimit:${key}`,
          String(windowSeconds),
        ])) as [number, number];
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
