import { RedisClient } from "bun";
import { Cause, Context, Effect, Exit, Layer } from "effect";

// A minimal cross-process publish/subscribe abstraction — just enough for
// RealtimeConnectionsLive (see Realtime.ts) to fan a realtime event out to
// every app instance, not a general Redis client wrapper.
export class PubSub extends Context.Tag("PubSub")<
  PubSub,
  {
    // `unknown` error channel (same idiom as Realtime.ts's `Writer`) — a
    // publish can genuinely fail against a real Redis, and callers need a
    // real failure to `Effect.ignore` rather than a defect that'd crash past
    // it.
    readonly publish: (
      channel: string,
      message: string,
    ) => Effect.Effect<void, unknown>;
    readonly subscribe: (
      channel: string,
      onMessage: (message: string) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    // Used by the `/ready` readiness endpoint (see Health.ts) to confirm
    // this instance's realtime fan-out path is actually reachable right now,
    // not just configured.
    readonly ping: Effect.Effect<void, unknown>;
  }
>() {}

// Single-process fan-out. This isn't a test stand-in for the real thing — a
// single process has nothing to distribute to *besides* its own local
// subscribers, so this is the fully correct implementation whenever there's
// only one app instance: local `bun run dev`, `bun test`, and PubSubLive's
// own fallback below when REDIS_URL isn't set.
//
// `publish` runs every matching subscriber's effect to completion before its
// own effect resolves — deliberately synchronous-feeling delivery, since
// nothing here crosses a process boundary. RedisPubSubLive below can't offer
// that guarantee (a real PUBLISH doesn't wait on subscribers), so code
// calling `publish` must not depend on delivery having happened by the time
// it returns.
export const InMemoryPubSubLive = Layer.sync(PubSub, () => {
  const subscribers = new Map<
    string,
    Set<(message: string) => Effect.Effect<void>>
  >();

  return {
    publish: (channel, message) =>
      Effect.gen(function* () {
        for (const onMessage of subscribers.get(channel) ?? []) {
          yield* onMessage(message);
        }
      }),
    subscribe: (channel, onMessage) =>
      Effect.sync(() => {
        const listeners = subscribers.get(channel) ?? new Set();
        listeners.add(onMessage);
        subscribers.set(channel, listeners);
      }),
    // No external dependency to lose — a single process is always ready to
    // fan out to its own local subscribers.
    ping: Effect.void,
  };
});

// Real cross-process fan-out via Redis Pub/Sub, using Bun's native client —
// what lets multiple horizontally-scaled app instances share realtime
// events. A subscribed `RedisClient` connection can't also publish (see
// Bun's redis docs), so this keeps a dedicated `.duplicate()`d connection for
// each direction.
export const RedisPubSubLive = Layer.effect(
  PubSub,
  Effect.promise(async () => {
    const publisher = new RedisClient(process.env.REDIS_URL);
    const subscriber = await publisher.duplicate();

    return {
      publish: (channel: string, message: string) =>
        Effect.tryPromise(() => publisher.publish(channel, message)).pipe(
          Effect.asVoid,
        ),
      subscribe: (
        channel: string,
        onMessage: (message: string) => Effect.Effect<void>,
      ) =>
        Effect.promise(() =>
          subscriber.subscribe(channel, (message) => {
            // `subscribe`'s callback is a bare Node-style callback, not an
            // Effect, so the handler has to be forked rather than yielded —
            // but a bare `runFork` throws the resulting fiber away, silently
            // swallowing whatever it fails or dies with (e.g. a malformed
            // envelope). Observe the exit and log failures so a broken
            // subscriber shows up instead of just dropping the delivery.
            const fiber = Effect.runFork(onMessage(message));
            fiber.addObserver((exit) => {
              if (Exit.isFailure(exit)) {
                Effect.runFork(
                  Effect.logWarning(
                    "PubSub: dropped realtime delivery, subscriber handler failed",
                  ).pipe(
                    Effect.annotateLogs({
                      channel,
                      cause: Cause.pretty(exit.cause),
                    }),
                  ),
                );
              }
            });
          }),
        ).pipe(Effect.asVoid),
      ping: Effect.tryPromise(() => publisher.ping()).pipe(Effect.asVoid),
    };
  }),
);

// `REDIS_URL` unset — the default for local `bun run dev`/`bun test` — falls
// back to the in-memory implementation above, so horizontal scaling is
// opt-in via config rather than a hard requirement for local development.
// `docker compose up` (see docker-compose.yml) sets REDIS_URL to point at
// its `redis` service.
export const PubSubLive = process.env.REDIS_URL
  ? RedisPubSubLive
  : InMemoryPubSubLive;
