import { Cause, Context, Effect, Exit, Layer, Metric } from "effect";
import { pubsubPublishTotal, pubsubSubscribeTotal } from "./Metrics.ts";
import { redisFallback, supervisedRedis } from "./redisConnection.ts";

// Tags `pubsub_publish_total`/`pubsub_subscribe_total` (see Metrics.ts) with
// their outcome and records it — shared by both PubSub implementations
// below so publish/subscribe success and failure counts (issue #124) are
// consistent regardless of which one's active.
const trackOutcome = <A, E>(
  metric: typeof pubsubPublishTotal,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.tap(() =>
      Metric.update(Metric.withAttributes(metric, { outcome: "success" }), 1),
    ),
    Effect.tapError(() =>
      Metric.update(Metric.withAttributes(metric, { outcome: "failure" }), 1),
    ),
  );

// A minimal cross-process publish/subscribe abstraction — just enough for
// RealtimeConnectionsLive (see Realtime.ts) to fan a realtime event out to
// every app instance, not a general Redis client wrapper.
export class PubSub extends Context.Service<
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
    // Runs `listener` whenever this instance's subscription connection
    // reconnects. Messages published while it was down are gone, so state
    // kept in step by a channel — the auth cache (see Auth.ts), the
    // clients' caches (see Realtime.ts) — must be put right then rather
    // than trusted (issues #832, #833). May also run on the first connect,
    // so listeners must be harmless then.
    readonly onReconnect: (
      listener: Effect.Effect<void>,
    ) => Effect.Effect<void>;
  }
>()("PubSub") {}

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
      trackOutcome(
        pubsubPublishTotal,
        Effect.gen(function* () {
          for (const onMessage of subscribers.get(channel) ?? []) {
            yield* onMessage(message);
          }
        }),
      ),
    subscribe: (channel, onMessage) =>
      trackOutcome(
        pubsubSubscribeTotal,
        Effect.sync(() => {
          const listeners = subscribers.get(channel) ?? new Set();
          listeners.add(onMessage);
          subscribers.set(channel, listeners);
        }),
      ),
    // No external dependency to lose — a single process is always ready to
    // fan out to its own local subscribers.
    ping: Effect.void,
    // Nothing to reconnect, so nothing is ever missed.
    onReconnect: () => Effect.void,
  };
});

// Real cross-process fan-out via Redis Pub/Sub, using Bun's native client —
// what lets multiple horizontally-scaled app instances share realtime
// events. A subscribed connection can't also publish (see Bun's redis
// docs), so there's one connection for each direction, both from
// `supervisedRedis` (redisConnection.ts).
//
// While Redis is unreachable (issue #832) a publish is handed straight to
// this instance's own subscribers for its channel, the way
// InMemoryPubSubLive does: everyone connected to this instance keeps
// getting the events it publishes, and only those meant for other
// instances are lost — until Redis is back, when `onReconnect` listeners
// put things right. The publish itself then succeeds (it's counted as a
// `failure` in `pubsub_publish_total` and in `redis_fallbacks_total`), so
// callers don't log an outage once per event.
export const RedisPubSubLive = Layer.effect(
  PubSub,
  Effect.gen(function* () {
    const publisher = supervisedRedis("pubsub-publish");
    const subscriber = supervisedRedis("pubsub-subscribe");
    yield* Effect.promise(() =>
      Promise.all([publisher.ready, subscriber.ready]),
    );

    // Every handler subscribed on this instance, by channel — what a
    // reconnect has to restore, and what a publish falls back to. The app
    // subscribes to more than one channel on the same subscriber
    // connection (`chat-platform:realtime` and this instance's own channel
    // from Realtime.ts, `auth:invalidation` from Auth.ts), so this can't be
    // tracked per `subscribe` call (issue #649).
    const subscriptions = new Map<string, Array<(message: string) => void>>();
    const reconnectListeners: Array<Effect.Effect<void>> = [];

    // Redis pub/sub subscriptions live on the connection, not the account —
    // a fresh connection starts with none. Without this, an instance would
    // silently stop receiving cross-instance events after any blip until
    // restarted (see issue #52); it re-issues *every* channel (#649).
    const resubscribe = (
      channel: string,
      handlers: Array<(m: string) => void>,
    ) =>
      // Bun's client-side listener list isn't cleared across reconnects, so
      // subscribing again without unsubscribing first would register a
      // second listener on the same channel — delivering every future
      // message twice. Unsubscribing drops every listener on the channel,
      // so all of its handlers are re-added after.
      Effect.tryPromise(() => subscriber.client.unsubscribe(channel)).pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.forEach(
            handlers,
            (handler) =>
              Effect.tryPromise(() =>
                subscriber.client.subscribe(channel, handler),
              ),
            { discard: true },
          ),
        ),
        Effect.catch((error) =>
          Effect.logWarning(
            "PubSub: failed to resubscribe after Redis reconnect",
          ).pipe(Effect.annotateLogs({ channel, error: String(error) })),
        ),
      );
    // Every connect after the boot-time one (awaited above): a reconnect,
    // or the first connect of an instance that booted without Redis.
    subscriber.onConnect(
      Effect.gen(function* () {
        yield* Effect.forEach(
          [...subscriptions],
          ([channel, handlers]) => resubscribe(channel, handlers),
          { discard: true },
        );
        // After the subscriptions are back, so whatever a listener sets
        // off is heard.
        yield* Effect.forEach(reconnectListeners, (listener) => listener, {
          discard: true,
        });
      }),
    );

    return {
      publish: (channel: string, message: string) =>
        trackOutcome(
          pubsubPublishTotal,
          Effect.tryPromise(() =>
            publisher.client.publish(channel, message),
          ).pipe(Effect.asVoid),
        ).pipe(
          Effect.catch((error) =>
            redisFallback(publisher, "pubsub", "publish", error).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  for (const handler of subscriptions.get(channel) ?? [])
                    handler(message);
                }),
              ),
            ),
          ),
        ),
      subscribe: (
        channel: string,
        onMessage: (message: string) => Effect.Effect<void>,
      ) => {
        // `subscribe`'s callback is a bare Node-style callback, not an
        // Effect, so the handler has to be forked rather than yielded — but
        // a bare `runFork` throws the resulting fiber away, silently
        // swallowing whatever it fails or dies with (e.g. a malformed
        // envelope). Observe the exit and log failures so a broken
        // subscriber shows up instead of just dropping the delivery.
        const handleMessage = (message: string) => {
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
        };
        const handlers = subscriptions.get(channel) ?? [];
        handlers.push(handleMessage);
        subscriptions.set(channel, handlers);

        // Recorded first: if Redis is down now — at boot, say — the
        // reconnect subscribes it, and publishes reach it locally meanwhile.
        return trackOutcome(
          pubsubSubscribeTotal,
          Effect.tryPromise(() =>
            subscriber.client.subscribe(channel, handleMessage),
          ),
        ).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            redisFallback(subscriber, "pubsub", "subscribe", error),
          ),
        );
      },
      ping: Effect.tryPromise(() => publisher.client.ping()).pipe(
        Effect.asVoid,
      ),
      onReconnect: (listener: Effect.Effect<void>) =>
        Effect.sync(() => {
          reconnectListeners.push(listener);
        }),
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
