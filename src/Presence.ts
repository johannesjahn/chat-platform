import { Context, Duration, Effect, Layer, Schedule } from "effect";
import { redisFallback, supervisedRedis } from "./redisConnection.ts";

// Tracks how many live `/ws` connections each user has *across every app
// instance* — not just the local one handling a given connect/disconnect.
// `RealtimeConnections` (see Realtime.ts) uses this to decide when a user's
// global connection count genuinely transitions to/from zero (so it knows
// whether to push a `presence` event at all) and which of a freshly-connecting
// client's contacts to hand it as its initial "who's online" snapshot.
//
// This used to be inferred from each instance's own local connection
// registry (`byUser` in Realtime.ts), which is wrong under horizontal
// scaling in two ways: a user with a tab connected to instance A and another
// to instance B would (a) get a spurious second "online" broadcast when the
// B tab opened, since B's local count also transitioned 0→1 even though the
// user was already online via A, and (b) get a *false* "offline" broadcast
// when *either* tab closed, since whichever instance's local count hit zero
// broadcast offline with no idea the user was still connected elsewhere.
// Moving the count itself into shared storage fixes both.
export class PresenceStore extends Context.Service<
  PresenceStore,
  {
    // Registers one more live connection for `userId`. Returns `true` only
    // if this was the global transition from zero connections to one — the
    // caller should broadcast `online: true` — and `false` if the user
    // already had a connection somewhere (this instance or another).
    readonly connect: (userId: number) => Effect.Effect<boolean>;
    // Removes one live connection for `userId`. Returns `true` only if this
    // was the global transition down to zero connections — the caller
    // should broadcast `online: false`.
    readonly disconnect: (userId: number) => Effect.Effect<boolean>;
    // Of `userIds`, the ones with at least one live connection anywhere
    // right now. Asked about a specific set (a connecting user's contacts,
    // see RealtimeSocket.ts) rather than "everyone online", so its cost
    // tracks the size of that set, not of the whole deployment (issue #660).
    readonly onlineAmong: (
      userIds: ReadonlyArray<number>,
    ) => Effect.Effect<ReadonlyArray<number>>;
    // Transitions the store discovers on its own rather than through
    // `connect`/`disconnect` (issue #837): users whose only connections
    // were on an instance that died without cleaning up (now offline), and
    // users of this instance coming back after it was wrongly taken for
    // dead (online again). The caller pushes the presence events.
    readonly onPresenceChange: (
      listener: (changes: ReadonlyArray<PresenceChange>) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
  }
>()("PresenceStore") {}

export type PresenceChange = {
  readonly userId: number;
  readonly online: boolean;
};

// Single-process fan-out has nothing "other instances" could mean, so the
// local count *is* the global count — same reasoning as PubSub.ts's
// InMemoryPubSubLive being the fully correct implementation for one process,
// not a stand-in.
export const InMemoryPresenceStoreLive = Layer.sync(PresenceStore, () => {
  const counts = new Map<number, number>();

  return {
    connect: (userId) =>
      Effect.sync(() => {
        const next = (counts.get(userId) ?? 0) + 1;
        counts.set(userId, next);
        return next === 1;
      }),
    disconnect: (userId) =>
      Effect.sync(() => {
        const current = counts.get(userId) ?? 0;
        // A disconnect for a user with no tracked connection can't be a
        // real transition — every real caller (Realtime.ts's `register`
        // cleanup) only ever calls this after a matching `connect`, so this
        // guard is purely defensive.
        if (current <= 0) return false;
        const next = current - 1;
        if (next > 0) {
          counts.set(userId, next);
          return false;
        }
        counts.delete(userId);
        return true;
      }),
    onlineAmong: (userIds) =>
      Effect.sync(() => userIds.filter((userId) => counts.has(userId))),
    // One process can't outlive its own connections.
    onPresenceChange: () => Effect.void,
  };
});

// Real cross-process count via a Redis hash (`userId` field → connection
// count), keeping every instance's view of "is this user online anywhere"
// consistent. `HINCRBY` is atomic, so two instances handling this user's
// connect/disconnect at the same moment can't race each other into an
// inconsistent count the way two independent local counters could.
const KEY = "chat-platform:presence:counts";
// Which instances are alive: a sorted set of instance id -> last heartbeat
// (Redis' own clock, ms), and per instance, its share of every count in
// KEY (issue #837).
const REGISTRY_KEY = "chat-platform:presence:instances";
const INSTANCE_KEY_PREFIX = "chat-platform:presence:instance:";

// Safety net for a hard process kill (SIGKILL — OOM killer, `docker kill`, a
// spot-instance reclaim): `disconnect` never runs in that case, so nothing
// would otherwise ever `HDEL` the field this instance incremented, leaking
// it — and the user showing "online" — forever (issue #102 part 1). Every
// field an instance holds a live connection for gets its per-field TTL
// (`HEXPIRE`, Redis 7.4+) refreshed on each heartbeat, so a field nobody
// refreshes expires within FIELD_TTL_SECONDS. A graceful `disconnect` still
// removes the field immediately via `HDEL`.
//
// That TTL alone wasn't enough (issue #837): when the user reconnected to
// another instance, *that* instance refreshed the same field, so the dead
// instance's +1 lived on — the count never got back to zero, and when the
// user later left, their contacts never got `online: false`. So each
// instance also records its own share of every count, and heartbeats into
// REGISTRY_KEY; any instance's heartbeat reaps the instances that stopped
// (REAP_SCRIPT): subtracts their shares and reports the users that went
// offline, for the presence events the dead instance never sent. The field
// TTL stays as the last resort for when no instance is left to reap.
//
// The TTLs are generous relative to the heartbeat interval so a couple of
// missed beats (a GC pause, a brief Redis hiccup) can't flip a still-live
// user offline — and an instance that *was* wrongly reaped re-registers
// its counts on its next beat (see the heartbeat below).
const FIELD_TTL_SECONDS = 60;

// How often each instance heartbeats, and how long an instance may go
// without one before another instance reaps it. A reference so tests can
// shorten both.
export const PresenceHeartbeat = Context.Reference<{
  readonly interval: Duration.Duration;
  readonly deadAfter: Duration.Duration;
}>("chat-platform/Presence/PresenceHeartbeat", {
  defaultValue: () => ({
    interval: Duration.seconds(20),
    deadAfter: Duration.seconds(60),
  }),
});

// KEYS: counts, this instance's shares. ARGV: userId, n, field TTL.
// Returns the user's new global count.
const CONNECT_SCRIPT = `
redis.call("HINCRBY", KEYS[2], ARGV[1], ARGV[2])
local count = redis.call("HINCRBY", KEYS[1], ARGV[1], ARGV[2])
redis.call("HEXPIRE", KEYS[1], ARGV[3], "FIELDS", 1, ARGV[1])
return count
`;

// KEYS: counts, this instance's shares. ARGV: userId. Returns
// {held, count}: held is 0 if this instance holds no share for the user (it
// was reaped meanwhile, so the reaper already took its share off), else the
// user's new global count follows.
const DISCONNECT_SCRIPT = `
local share = tonumber(redis.call("HGET", KEYS[2], ARGV[1]) or "0")
if share <= 0 then return {0, 0} end
if share == 1 then
  redis.call("HDEL", KEYS[2], ARGV[1])
else
  redis.call("HINCRBY", KEYS[2], ARGV[1], -1)
end
local count = redis.call("HINCRBY", KEYS[1], ARGV[1], -1)
if count <= 0 then redis.call("HDEL", KEYS[1], ARGV[1]) end
return {1, count}
`;

// KEYS: registry, this instance's shares. ARGV: instance id, shares TTL.
// Returns 1 if the instance wasn't registered (first beat, or reaped).
const HEARTBEAT_SCRIPT = `
local t = redis.call("TIME")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local added = redis.call("ZADD", KEYS[1], now, ARGV[1])
redis.call("EXPIRE", KEYS[2], ARGV[2])
return added
`;

// KEYS: counts, registry. ARGV: dead-after ms, shares key prefix, this
// instance's id. Reaps every instance whose last heartbeat is older than
// dead-after: subtracts its shares from the counts and returns the users
// whose count reached zero. ZREM gates each instance, so of several reapers
// running at once exactly one handles it. (Touches each dead instance's
// shares key by name — fine on a single Redis, not on Redis Cluster.)
const REAP_SCRIPT = `
local t = redis.call("TIME")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local offline = {}
local dead = redis.call("ZRANGEBYSCORE", KEYS[2], "-inf", now - tonumber(ARGV[1]))
for _, instance in ipairs(dead) do
  if instance ~= ARGV[3] and redis.call("ZREM", KEYS[2], instance) == 1 then
    local sharesKey = ARGV[2] .. instance
    local shares = redis.call("HGETALL", sharesKey)
    for i = 1, #shares, 2 do
      local count = redis.call("HINCRBY", KEYS[1], shares[i], -tonumber(shares[i + 1]))
      if count <= 0 then
        redis.call("HDEL", KEYS[1], shares[i])
        table.insert(offline, shares[i])
      end
    end
    redis.call("DEL", sharesKey)
  end
end
return offline
`;

// KEYS: counts, this instance's shares. ARGV: field TTL, then userId, n
// pairs — every user this instance holds, with its local connection count.
// Makes the instance's shares exactly that, moving the global counts by the
// difference, and returns the transitions it caused as userId, online
// (1/0) pairs. What puts presence right after Redis was unreachable (issue
// #832) — connects and disconnects that failed meanwhile never reached it —
// or after this instance was reaped while alive (its shares are gone, so
// all of them come back), or after Redis restarted empty.
const RESYNC_SCRIPT = `
local want = {}
for i = 2, #ARGV, 2 do want[ARGV[i]] = tonumber(ARGV[i + 1]) end
local have = {}
local held = redis.call("HGETALL", KEYS[2])
for i = 1, #held, 2 do have[held[i]] = tonumber(held[i + 1]) end
local changes = {}
local function adjust(user, delta)
  if delta == 0 then return end
  local before = tonumber(redis.call("HGET", KEYS[1], user) or "0")
  local after = redis.call("HINCRBY", KEYS[1], user, delta)
  if after <= 0 then
    redis.call("HDEL", KEYS[1], user)
  else
    redis.call("HEXPIRE", KEYS[1], ARGV[1], "FIELDS", 1, user)
  end
  if before <= 0 and after > 0 then
    table.insert(changes, user)
    table.insert(changes, 1)
  elseif before > 0 and after <= 0 then
    table.insert(changes, user)
    table.insert(changes, 0)
  end
end
for user, n in pairs(have) do
  if not want[user] then
    adjust(user, -n)
    redis.call("HDEL", KEYS[2], user)
  end
end
for user, n in pairs(want) do
  adjust(user, n - (have[user] or 0))
  redis.call("HSET", KEYS[2], user, n)
end
return changes
`;

export const RedisPresenceStoreLive = Layer.effect(
  PresenceStore,
  Effect.gen(function* () {
    const supervised = supervisedRedis("presence");
    yield* Effect.promise(() => supervised.ready);
    const redis = supervised.client;
    const heartbeat = yield* PresenceHeartbeat;
    const instanceId = crypto.randomUUID();
    const sharesKey = `${INSTANCE_KEY_PREFIX}${instanceId}`;
    // A day: only a backstop for an instance nobody ever reaps.
    const SHARES_TTL_SECONDS = 86_400;
    const deadAfterMs = Duration.toMillis(heartbeat.deadAfter);

    // Issue #102 part 2: connect/disconnect/onlineAmong all fail soft
    // (Redis being unreachable must never fail a `/ws` connection), which
    // previously meant a Redis blip silently degraded presence with nothing
    // surfacing it. Logging here at least leaves a trail.
    const logFallback = (operation: string, error: unknown) =>
      redisFallback(supervised, "presence", operation, error);

    // This instance's own view of which users it's currently holding at
    // least one live `/ws` connection for — separate from (but analogous
    // to) RealtimeConnections' local `byUser` map (see Realtime.ts). Kept
    // whether or not Redis took the change, since it's what `resync` puts
    // back. The heartbeat refreshes their fields.
    const localCounts = new Map<number, number>();
    const countLocally = (userId: number, delta: number) => {
      const next = (localCounts.get(userId) ?? 0) + delta;
      if (next > 0) localCounts.set(userId, next);
      else localCounts.delete(userId);
    };

    const listeners: Array<
      (changes: ReadonlyArray<PresenceChange>) => Effect.Effect<void>
    > = [];
    const emit = (changes: ReadonlyArray<PresenceChange>) =>
      changes.length === 0
        ? Effect.void
        : Effect.forEach(listeners, (listener) => listener(changes), {
            discard: true,
          });

    const evalScript = (
      script: string,
      keys: ReadonlyArray<string>,
      args: ReadonlyArray<string | number>,
    ) =>
      Effect.tryPromise(() =>
        redis.send("EVAL", [
          script,
          String(keys.length),
          ...keys,
          ...args.map(String),
        ]),
      );

    const register = evalScript(
      HEARTBEAT_SCRIPT,
      [REGISTRY_KEY, sharesKey],
      [instanceId, SHARES_TTL_SECONDS],
    ).pipe(Effect.map((added) => Number(added) === 1));

    // Registered before the first connection lands, so its share is never
    // held by an instance the reaper can't see.
    yield* register.pipe(
      Effect.catch((error) =>
        logFallback("register", error).pipe(Effect.as(false)),
      ),
    );

    // Best-effort, like the realtime push itself (see Realtime.ts's
    // notifyUsers): a `/ws` connection succeeding shouldn't depend on Redis
    // being reachable, and a transient failure should conservatively *not*
    // claim a transition happened (suppressing a presence broadcast) rather
    // than crash connection setup or report a wrong transition.
    const connect: PresenceStore["Service"]["connect"] = (userId) =>
      Effect.sync(() => countLocally(userId, 1)).pipe(
        Effect.andThen(
          evalScript(
            CONNECT_SCRIPT,
            [KEY, sharesKey],
            [userId, 1, FIELD_TTL_SECONDS],
          ),
        ),
        Effect.map((count) => Number(count) === 1),
        Effect.catch((error) =>
          logFallback("connect", error).pipe(Effect.as(false)),
        ),
      );

    const disconnect: PresenceStore["Service"]["disconnect"] = (userId) =>
      Effect.sync(() => countLocally(userId, -1)).pipe(
        Effect.andThen(
          evalScript(DISCONNECT_SCRIPT, [KEY, sharesKey], [userId]),
        ),
        // No share held (this instance was reaped): not a transition it can
        // vouch for — the reaper already reported it.
        Effect.map((result) => {
          const [held, count] = result as [number, number];
          return Number(held) === 1 && Number(count) <= 0;
        }),
        Effect.catch((error) =>
          logFallback("disconnect", error).pipe(Effect.as(false)),
        ),
      );

    // One `HMGET` for the whole set; a field only exists while its count is
    // positive (`disconnect` deletes it at zero), but a stray non-positive
    // value is treated as offline all the same.
    const onlineAmong: PresenceStore["Service"]["onlineAmong"] = (userIds) =>
      userIds.length === 0
        ? Effect.succeed([])
        : Effect.tryPromise(() => redis.hmget(KEY, userIds.map(String))).pipe(
            Effect.map((counts) =>
              userIds.filter((_, i) => Number(counts[i] ?? 0) > 0),
            ),
            Effect.catch((error) =>
              logFallback("onlineAmong", error).pipe(
                Effect.as([] as ReadonlyArray<number>),
              ),
            ),
          );

    const refreshTtl = (userId: number): Effect.Effect<void> =>
      Effect.tryPromise(() =>
        redis.hexpire(KEY, FIELD_TTL_SECONDS, "FIELDS", 1, String(userId)),
      ).pipe(
        Effect.asVoid,
        Effect.catch((error) => logFallback("heartbeat", error)),
      );

    // Makes this instance's shares match `localCounts` and tells contacts
    // about every transition that caused (see RESYNC_SCRIPT): after being
    // reaped while alive (a long pause), and whenever Redis comes back.
    const resync = Effect.suspend(() =>
      evalScript(
        RESYNC_SCRIPT,
        [KEY, sharesKey],
        [FIELD_TTL_SECONDS, ...[...localCounts].flat()],
      ),
    ).pipe(
      Effect.map((result) => {
        const flat = result as Array<string | number>;
        const changes: PresenceChange[] = [];
        for (let i = 0; i < flat.length; i += 2) {
          changes.push({
            userId: Number(flat[i]),
            online: Number(flat[i + 1]) === 1,
          });
        }
        return changes;
      }),
      Effect.flatMap(emit),
      Effect.catch((error) => logFallback("resync", error)),
    );

    const reap = evalScript(
      REAP_SCRIPT,
      [KEY, REGISTRY_KEY],
      [deadAfterMs, INSTANCE_KEY_PREFIX, instanceId],
    ).pipe(
      Effect.flatMap((offline) =>
        emit(
          (offline as string[]).map((id) => ({
            userId: Number(id),
            online: false,
          })),
        ),
      ),
      Effect.catch((error) => logFallback("reap", error)),
    );

    // Each beat: re-register (restoring this instance's shares if it had
    // been reaped), refresh the TTL of every field it holds, then reap
    // instances that stopped beating. `Effect.suspend` defers reading
    // `localCounts` to each tick. Tied to this layer's scope so it's
    // interrupted on shutdown.
    const beat = Effect.gen(function* () {
      const wasReaped = yield* register.pipe(
        Effect.catch((error) =>
          logFallback("register", error).pipe(Effect.as(false)),
        ),
      );
      if (wasReaped) yield* resync;
      yield* Effect.forEach([...localCounts.keys()], refreshTtl, {
        concurrency: "unbounded",
        discard: true,
      });
      yield* reap;
    });
    yield* Effect.forkScoped(
      Effect.suspend(() => beat).pipe(
        Effect.repeat(Schedule.spaced(heartbeat.interval)),
      ),
    );
    // Whenever Redis is reachable again: re-register (the reaper may have
    // taken this instance for dead meanwhile) and resync.
    supervised.onConnect(
      register.pipe(
        Effect.catch((error) => logFallback("register", error)),
        Effect.andThen(resync),
      ),
    );

    const onPresenceChange: PresenceStore["Service"]["onPresenceChange"] = (
      listener,
    ) =>
      Effect.sync(() => {
        listeners.push(listener);
      });

    return { connect, disconnect, onlineAmong, onPresenceChange };
  }),
);

// `REDIS_URL` unset — same default-to-local-instance reasoning as
// PubSubLive — falls back to the in-memory implementation.
export const PresenceStoreLive = process.env.REDIS_URL
  ? RedisPresenceStoreLive
  : InMemoryPresenceStoreLive;
