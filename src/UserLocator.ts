import { Context, Duration, Effect, Layer, Schedule } from "effect";
import { redisFallback, supervisedRedis } from "./redisConnection.ts";

// Which app instances hold at least one live `/ws` connection for a user
// (issue #832). Every realtime event used to be published on one shared
// channel that every instance received and parsed, whether or not it held
// any of the recipients — so each instance's cost grew with the whole
// cluster's event volume, and Redis sent every event once per instance.
// With this directory, an event for specific users is published only to the
// instances that hold them (see `notifyUsers` in Realtime.ts), and an event
// for users who are offline everywhere isn't published at all.
//
// Best-effort, like the events themselves: a lookup that fails returns
// `null`, and the caller falls back to the shared channel.
export class UserLocator extends Context.Service<
  UserLocator,
  {
    // `instanceId` now holds a connection for `userId` (its first one).
    readonly claim: (userId: number, instanceId: string) => Effect.Effect<void>;
    // `instanceId` no longer holds any connection for `userId`.
    readonly release: (
      userId: number,
      instanceId: string,
    ) => Effect.Effect<void>;
    // Keeps `instanceId`'s claims alive (see the Redis TTL below); called on
    // a heartbeat with every user the instance still holds.
    readonly refresh: (
      userIds: ReadonlyArray<number>,
      instanceId: string,
    ) => Effect.Effect<void>;
    // instance id -> the given users connected there. Users connected
    // nowhere are absent; `null` if the lookup failed.
    readonly locate: (
      userIds: ReadonlyArray<number>,
    ) => Effect.Effect<Map<string, number[]> | null>;
    // Runs `listener` whenever the directory becomes reachable again after
    // an outage (issue #832): claims made or released meanwhile never
    // reached it, so the caller re-asserts what it holds.
    readonly onReconnect: (
      listener: Effect.Effect<void>,
    ) => Effect.Effect<void>;
  }
>()("UserLocator") {}

// Per-process directory. Correct for a single process (local dev, tests),
// and shared by every RealtimeConnectionsLive in that process — which is how
// the tests stand in for several replicas.
export const makeInMemoryUserLocator = (): UserLocator["Service"] => {
  const byUser = new Map<number, Set<string>>();
  return {
    claim: (userId, instanceId) =>
      Effect.sync(() => {
        const set = byUser.get(userId) ?? new Set();
        set.add(instanceId);
        byUser.set(userId, set);
      }),
    release: (userId, instanceId) =>
      Effect.sync(() => {
        const set = byUser.get(userId);
        set?.delete(instanceId);
        if (set?.size === 0) byUser.delete(userId);
      }),
    refresh: () => Effect.void,
    // Nothing to lose.
    onReconnect: () => Effect.void,
    locate: (userIds) =>
      Effect.sync(() => {
        const located = new Map<string, number[]>();
        for (const userId of new Set(userIds)) {
          for (const instanceId of byUser.get(userId) ?? []) {
            const ids = located.get(instanceId) ?? [];
            ids.push(userId);
            located.set(instanceId, ids);
          }
        }
        return located;
      }),
  };
};

export const InMemoryUserLocatorLive = Layer.sync(
  UserLocator,
  makeInMemoryUserLocator,
);

const userKey = (userId: number) =>
  `chat-platform:realtime:user:${userId}:instances`;

// A claim lives this long without a refresh, so an instance that dies
// without releasing (a hard kill) stops being sent its users' events within
// it. Refreshed by RealtimeConnections' heartbeat well inside that.
export const CLAIM_TTL_SECONDS = 60;
export const CLAIM_REFRESH_INTERVAL = Duration.seconds(20);

// KEYS: the users' sets. Returns each set's members, in order.
const LOCATE_SCRIPT = `
local result = {}
for i, key in ipairs(KEYS) do
  result[i] = redis.call("SMEMBERS", key)
end
return result
`;

// KEYS: the users' sets. ARGV: instance id, TTL.
const REFRESH_SCRIPT = `
for _, key in ipairs(KEYS) do
  redis.call("SADD", key, ARGV[1])
  redis.call("EXPIRE", key, ARGV[2])
end
return 0
`;

export const RedisUserLocatorLive = Layer.effect(
  UserLocator,
  Effect.gen(function* () {
    const supervised = supervisedRedis("user-locator");
    yield* Effect.promise(() => supervised.ready);
    const redis = supervised.client;
    const logFailure = (operation: string, error: unknown) =>
      redisFallback(supervised, "user-locator", operation, error);

    const refresh: UserLocator["Service"]["refresh"] = (userIds, instanceId) =>
      userIds.length === 0
        ? Effect.void
        : Effect.tryPromise(() =>
            redis.send("EVAL", [
              REFRESH_SCRIPT,
              String(userIds.length),
              ...userIds.map(userKey),
              instanceId,
              String(CLAIM_TTL_SECONDS),
            ]),
          ).pipe(
            Effect.asVoid,
            Effect.catch((error) => logFailure("refresh", error)),
          );

    return {
      claim: (userId, instanceId) => refresh([userId], instanceId),
      release: (userId, instanceId) =>
        Effect.tryPromise(() => redis.srem(userKey(userId), instanceId)).pipe(
          Effect.asVoid,
          Effect.catch((error) => logFailure("release", error)),
        ),
      refresh,
      locate: (userIds) => {
        const unique = [...new Set(userIds)];
        if (unique.length === 0) return Effect.succeed(new Map());
        return Effect.tryPromise(() =>
          redis.send("EVAL", [
            LOCATE_SCRIPT,
            String(unique.length),
            ...unique.map(userKey),
          ]),
        ).pipe(
          Effect.map((sets) => {
            const located = new Map<string, number[]>();
            (sets as string[][]).forEach((instances, i) => {
              for (const instanceId of instances) {
                const ids = located.get(instanceId) ?? [];
                ids.push(unique[i]!);
                located.set(instanceId, ids);
              }
            });
            return located;
          }),
          Effect.catch((error) =>
            logFailure("locate", error).pipe(Effect.as(null)),
          ),
        );
      },
      onReconnect: (listener) =>
        Effect.sync(() => supervised.onConnect(listener)),
    };
  }),
);

export const UserLocatorLive = process.env.REDIS_URL
  ? RedisUserLocatorLive
  : InMemoryUserLocatorLive;

// Re-asserts an instance's claims on a fixed beat, for the life of the
// calling layer's scope (see RealtimeConnectionsLive), and at once whenever
// the directory comes back after an outage.
export const forkClaimRefresher = (
  locator: UserLocator["Service"],
  instanceId: string,
  heldUsers: () => ReadonlyArray<number>,
) =>
  Effect.gen(function* () {
    const refreshNow = Effect.suspend(() =>
      locator.refresh(heldUsers(), instanceId),
    );
    yield* locator.onReconnect(refreshNow);
    yield* Effect.forkScoped(
      refreshNow.pipe(Effect.repeat(Schedule.spaced(CLAIM_REFRESH_INTERVAL))),
    );
  });
