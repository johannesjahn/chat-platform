import { RedisClient, type RedisOptions } from "bun";
import { Effect, Metric } from "effect";
import { redisConnectionUp, redisFallbacksTotal } from "./Metrics.ts";

// Redis connections that survive Redis going away (issue #832).
//
// Redis is a single instance: rate limits, `/ws` tickets, presence, the user
// directory and cross-instance events all live in it. Bun's client, left at
// its defaults, turned an outage into a full one: while it reconnects it
// *queues* every command (so every request that touches Redis — every
// request, via the global rate limit — hung), and after `maxRetries` it
// gives up for good, failing every command even once Redis is back, until
// the process restarts. Since /ready failed meanwhile and /health didn't, a
// pod was taken out of rotation and never restarted.
//
// So every Redis client in the app comes from here:
//
// - **Fail fast.** The offline queue is off: while the connection is down a
//   command rejects at once, and the caller falls back to its own
//   instance-local state (each component documents what that means).
// - **Never give up.** When Bun's own reconnect attempts run out, this keeps
//   calling `connect()` with a capped backoff for as long as the process
//   lives.
// - **Say when it's back.** `onConnect` listeners run on every connect, so
//   state that drifted while Redis was unreachable (presence shares,
//   directory claims, subscriptions, missed events) can be put right.

export const REDIS_CLIENT_OPTIONS = {
  enableOfflineQueue: false,
  connectionTimeout: 2_000,
  autoReconnect: true,
  maxRetries: 10,
} satisfies RedisOptions;

// How long to wait between `connect()` attempts once Bun has given up:
// doubling from the first to the last.
export const RECONNECT_BACKOFF_MS = [500, 5_000] as const;

export interface SupervisedRedis {
  readonly client: RedisClient;
  // Whether the connection is up right now.
  readonly isUp: () => boolean;
  // Settles once the first connect has succeeded or a connection timeout
  // has passed. Never rejects. A layer waits on it so a healthy boot
  // doesn't start out on the fallbacks.
  readonly ready: Promise<void>;
  // Runs `listener` on every connect from now on — reconnects, and the
  // first connect if it hasn't happened yet. Bun runs `onconnect` outside
  // any fiber, so the listener is forked.
  readonly onConnect: (listener: Effect.Effect<void>) => void;
}

export const supervisedRedis = (
  name: string,
  url = process.env.REDIS_URL,
  // For tests: e.g. a lower `maxRetries`, to reach the give-up quickly.
  options: RedisOptions = {},
): SupervisedRedis => {
  const client = new RedisClient(url, { ...REDIS_CLIENT_OPTIONS, ...options });
  const listeners: Array<Effect.Effect<void>> = [];
  const up = Metric.withAttributes(redisConnectionUp, { client: name });
  let connectedBefore = false;
  let wasUp = false;
  let delay: number = RECONNECT_BACKOFF_MS[0];
  let retry: ReturnType<typeof setTimeout> | undefined;

  const markDown = (error: unknown) => {
    Effect.runFork(Metric.update(up, 0));
    if (!wasUp) return;
    wasUp = false;
    Effect.runFork(
      Effect.logWarning(
        "Redis: connection lost; falling back to instance-local state",
      ).pipe(Effect.annotateLogs({ client: name, error: String(error) })),
    );
  };

  const scheduleConnect = () => {
    if (retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      client.connect().catch((error: unknown) => {
        markDown(error);
        delay = Math.min(delay * 2, RECONNECT_BACKOFF_MS[1]);
        scheduleConnect();
      });
    }, delay);
    // A pending reconnect never keeps the process alive on its own.
    retry.unref?.();
  };

  client.onconnect = () => {
    delay = RECONNECT_BACKOFF_MS[0];
    wasUp = true;
    Effect.runFork(Metric.update(up, 1));
    if (connectedBefore) {
      Effect.runFork(
        Effect.logInfo("Redis: reconnected").pipe(
          Effect.annotateLogs({ client: name }),
        ),
      );
    }
    connectedBefore = true;
    for (const listener of listeners) Effect.runFork(listener);
  };
  // Runs when Bun has given up reconnecting (or the first connect failed).
  client.onclose = (error) => {
    markDown(error);
    scheduleConnect();
  };

  // With the offline queue off the client doesn't connect lazily on its
  // first command, so connect now. Failing here is fine: the process boots
  // degraded and keeps trying.
  const connecting = client.connect().catch((error: unknown) => {
    markDown(error);
    scheduleConnect();
  });
  // Bun's `connect()` only settles once its own retries are over — ~11s
  // for an unreachable Redis — so a boot waits at most one connection
  // timeout, and goes on with Redis down if it's not there by then.
  const ready = Promise.race([
    connecting,
    Bun.sleep(
      options.connectionTimeout ?? REDIS_CLIENT_OPTIONS.connectionTimeout,
    ),
  ]).then(() => undefined);

  return {
    client,
    isUp: () => client.connected,
    ready,
    onConnect: (listener) => {
      listeners.push(listener);
    },
  };
};

// Counts an operation served from instance-local state because Redis
// failed, and logs it — but only when the connection looked up, i.e. an
// unexpected failure. During an outage every request would otherwise log,
// and `supervisedRedis` has already said the connection is gone.
export const redisFallback = (
  redis: SupervisedRedis,
  component: string,
  operation: string,
  error: unknown,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Metric.update(
      Metric.withAttributes(redisFallbacksTotal, { component }),
      1,
    );
    if (!redis.isUp()) return;
    yield* Effect.logWarning(
      "Redis: operation failed; served from instance-local state",
    ).pipe(Effect.annotateLogs({ component, operation, error: String(error) }));
  });
