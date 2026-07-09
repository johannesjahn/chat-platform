import { RedisClient } from "bun";
import { Context, Duration, Effect, Layer, Schedule } from "effect";

// Tracks how many live `/ws` connections each user has *across every app
// instance* — not just the local one handling a given connect/disconnect.
// `RealtimeConnections` (see Realtime.ts) uses this to decide when a user's
// global connection count genuinely transitions to/from zero (so it knows
// whether to broadcast a `presence` event at all) and what to hand a
// freshly-connecting client as its initial "who's online" snapshot.
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
export class PresenceStore extends Context.Tag("PresenceStore")<
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
    // Every user with at least one live connection anywhere right now.
    readonly onlineUserIds: Effect.Effect<ReadonlyArray<number>>;
  }
>() {}

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
    onlineUserIds: Effect.sync(() => [...counts.keys()]),
  };
});

// Real cross-process count via a Redis hash (`userId` field → connection
// count), keeping every instance's view of "is this user online anywhere"
// consistent. `HINCRBY` is atomic, so two instances handling this user's
// connect/disconnect at the same moment can't race each other into an
// inconsistent count the way two independent local counters could.
const KEY = "chat-platform:presence:counts";

// Safety net for a hard process kill (SIGKILL — OOM killer, `docker kill`, a
// spot-instance reclaim): `disconnect` never runs in that case, so nothing
// would otherwise ever `HDEL` the field this instance incremented, leaking
// it — and the user showing "online" — forever (issue #102 part 1). Instead,
// every field an instance is holding a live connection for gets its Redis
// per-field TTL (`HEXPIRE`, Redis 7.4+) refreshed on a heartbeat (see
// HEARTBEAT_INTERVAL below) for as long as that instance keeps heartbeating
// it. A crash just stops the heartbeat, so Redis itself expires the field
// within one FIELD_TTL_SECONDS window of the last successful refresh — no
// separate reconciliation job needed to clean it up (issue #102 part 4). A
// graceful `disconnect` still removes the field immediately via `HDEL`, same
// as before, so the common case sees no added staleness.
//
// The TTL is generous relative to the heartbeat interval so a couple of
// missed beats (a GC pause, a brief Redis hiccup) can't flip a still-live
// user offline.
const FIELD_TTL_SECONDS = 60;
const HEARTBEAT_INTERVAL = Duration.seconds(20);

export const RedisPresenceStoreLive = Layer.scoped(
  PresenceStore,
  Effect.gen(function* () {
    const redis = new RedisClient(process.env.REDIS_URL);

    // Issue #102 part 2: connect/disconnect/onlineUserIds all fail soft
    // (Redis being unreachable must never fail a `/ws` connection), which
    // previously meant a Redis blip silently degraded presence with nothing
    // surfacing it. Logging here at least leaves a trail.
    const logFallback = (operation: string, error: unknown) =>
      Effect.logWarning(
        "PresenceStore: Redis operation failed, presence update suppressed",
      ).pipe(Effect.annotateLogs({ operation, error: String(error) }));

    // This instance's own view of which users it's currently holding at
    // least one live `/ws` connection for — separate from (but analogous
    // to) RealtimeConnections' local `byUser` map (see Realtime.ts).
    // PresenceStore needs its own so the heartbeat below knows which fields
    // *this* instance is responsible for keeping alive; a second connection
    // for the same user landing on this instance must not stop the
    // heartbeat early just because one of its two connections closed.
    const localCounts = new Map<number, number>();

    // Always succeeds (failures are logged and swallowed) — a heartbeat
    // refresh failing must not fail the `connect` call that triggered it,
    // nor abort the rest of a heartbeat tick over other users.
    const refreshTtl = (userId: number): Effect.Effect<void> =>
      Effect.tryPromise(() =>
        redis.hexpire(KEY, FIELD_TTL_SECONDS, "FIELDS", 1, String(userId)),
      ).pipe(
        Effect.asVoid,
        Effect.catchAll((error) => logFallback("heartbeat", error)),
      );

    // Best-effort, like the realtime push itself (see Realtime.ts's
    // notifyUsers/broadcastAll): a `/ws` connection succeeding shouldn't
    // depend on Redis being reachable, and a transient failure should
    // conservatively *not* claim a transition happened (suppressing a
    // presence broadcast) rather than crash connection setup or, worse,
    // report a wrong transition.
    const connect: Context.Tag.Service<typeof PresenceStore>["connect"] = (
      userId,
    ) =>
      Effect.tryPromise(() => redis.hincrby(KEY, String(userId), 1)).pipe(
        Effect.tap(() => {
          localCounts.set(userId, (localCounts.get(userId) ?? 0) + 1);
          return refreshTtl(userId);
        }),
        Effect.map((count) => count === 1),
        Effect.catchAll((error) =>
          logFallback("connect", error).pipe(Effect.as(false)),
        ),
      );

    const disconnect: Context.Tag.Service<
      typeof PresenceStore
    >["disconnect"] = (userId) =>
      Effect.tryPromise(() => redis.hincrby(KEY, String(userId), -1)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const next = (localCounts.get(userId) ?? 1) - 1;
            if (next > 0) localCounts.set(userId, next);
            else localCounts.delete(userId);
          }),
        ),
        Effect.flatMap((count) => {
          if (count > 0) return Effect.succeed(false);
          // Back at (or below) zero — remove the field entirely (its TTL
          // goes with it) rather than leaving a `0` sitting in the hash
          // forever.
          //
          // Unlike InMemoryPresenceStoreLive, this doesn't special-case a
          // disconnect with no prior connect (that'd need an extra
          // round-trip to check first), so a stray call like that would
          // report `true` here instead of `false`. Harmless in practice: it
          // can't happen via the real call site (Realtime.ts's `register`
          // cleanup always pairs with a `connect`), and even if it did, a
          // spurious "offline" broadcast for a user nothing marked online
          // is a no-op for anyone consuming it (see web/src/lib/presence.ts,
          // which only reacts to an actual state change).
          return Effect.tryPromise(() => redis.hdel(KEY, String(userId))).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => true),
          );
        }),
        Effect.catchAll((error) =>
          logFallback("disconnect", error).pipe(Effect.as(false)),
        ),
      );

    const onlineUserIds: Effect.Effect<ReadonlyArray<number>> =
      Effect.tryPromise(() => redis.hkeys(KEY)).pipe(
        Effect.map((fields) => fields.map(Number)),
        Effect.catchAll((error) =>
          logFallback("onlineUserIds", error).pipe(
            Effect.as([] as ReadonlyArray<number>),
          ),
        ),
      );

    // Background heartbeat: every HEARTBEAT_INTERVAL, refresh the TTL of
    // every field this instance is still holding a connection for.
    // `Effect.suspend` defers reading `localCounts` to each tick — building
    // the array eagerly here would freeze on an empty snapshot taken before
    // any connection ever registered. Tied to this layer's scope so it's
    // interrupted on shutdown, same as RefreshTokenCleanupLive
    // (RefreshTokenCleanup.ts).
    yield* Effect.forkScoped(
      Effect.suspend(() =>
        Effect.forEach([...localCounts.keys()], refreshTtl, {
          concurrency: "unbounded",
          discard: true,
        }),
      ).pipe(Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL))),
    );

    return { connect, disconnect, onlineUserIds };
  }),
);

// `REDIS_URL` unset — same default-to-local-instance reasoning as
// PubSubLive — falls back to the in-memory implementation.
export const PresenceStoreLive = process.env.REDIS_URL
  ? RedisPresenceStoreLive
  : InMemoryPresenceStoreLive;
