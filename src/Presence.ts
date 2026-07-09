import { RedisClient } from "bun";
import { Context, Effect, Layer } from "effect";

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

export const RedisPresenceStoreLive = Layer.sync(PresenceStore, () => {
  const redis = new RedisClient(process.env.REDIS_URL);

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
      Effect.map((count) => count === 1),
      Effect.orElseSucceed(() => false),
    );

  const disconnect: Context.Tag.Service<typeof PresenceStore>["disconnect"] = (
    userId,
  ) =>
    Effect.tryPromise(() => redis.hincrby(KEY, String(userId), -1)).pipe(
      Effect.flatMap((count) => {
        if (count > 0) return Effect.succeed(false);
        // Back at (or below) zero — remove the field entirely rather than
        // leaving a `0` sitting in the hash forever.
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
      Effect.orElseSucceed(() => false),
    );

  const onlineUserIds: Effect.Effect<ReadonlyArray<number>> = Effect.tryPromise(
    () => redis.hkeys(KEY),
  ).pipe(
    Effect.map((fields) => fields.map(Number)),
    Effect.orElseSucceed((): ReadonlyArray<number> => []),
  );

  return { connect, disconnect, onlineUserIds };
});

// `REDIS_URL` unset — same default-to-local-instance reasoning as
// PubSubLive — falls back to the in-memory implementation.
export const PresenceStoreLive = process.env.REDIS_URL
  ? RedisPresenceStoreLive
  : InMemoryPresenceStoreLive;
