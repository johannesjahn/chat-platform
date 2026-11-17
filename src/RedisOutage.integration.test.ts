import { RedisClient, type Socket, type TCPSocketListener } from "bun";
import { afterAll, expect, test } from "bun:test";
import net from "node:net";
import { Duration, Effect, Layer, ManagedRuntime } from "effect";
import {
  PresenceHeartbeat,
  presenceCountsKey,
  RedisPresenceStoreLive,
} from "./Presence.ts";
import { staticPresenceAudience } from "./PresenceAudience.ts";
import { RedisPubSubLive } from "./PubSub.ts";
import { makeRedisRateLimiter } from "./RateLimiter.ts";
import {
  RealtimeConnections,
  RealtimeConnectionsLive,
  ResyncSpread,
} from "./Realtime.ts";
import { supervisedRedis } from "./redisConnection.ts";
import { RedisUserLocatorLive } from "./UserLocator.ts";
import { makeFallbackTickets, makeRedisWsTicket } from "./WsTicket.ts";

// Issue #832: Redis is a single instance, and the app has to keep serving —
// degraded — while it's unreachable, then put itself right when it's back.
// CI's Redis can't be stopped, so every client here goes through a TCP proxy
// the test cuts and restores, and the real Redis (REDIS_URL) is checked
// directly. Skipped without one, like the other Redis integration tests.
const realUrl = process.env.REDIS_URL;
const redisConfigured = Boolean(realUrl);
const redisTest = redisConfigured ? test : test.skip;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not determine a free port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

type ClientState = { upstream?: Socket<undefined>; pending: Uint8Array[] };

// Forwards 127.0.0.1:<port> to the real Redis. `cut` drops every connection
// and refuses new ones, as if Redis had gone away; `restore` listens again.
async function makeProxy(target: URL) {
  const port = await getFreePort();
  let listener: TCPSocketListener<ClientState> | undefined;
  const open = new Set<Socket<ClientState>>();

  const listen = () => {
    listener = Bun.listen<ClientState>({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(client) {
          client.data = { pending: [] };
          open.add(client);
          void Bun.connect({
            hostname: target.hostname,
            port: Number(target.port || 6379),
            socket: {
              data: (_, chunk) => void client.write(chunk),
              close: () => {
                client.end();
              },
              error: () => {
                client.end();
              },
            },
          }).then((upstream) => {
            client.data.upstream = upstream;
            for (const chunk of client.data.pending.splice(0))
              upstream.write(chunk);
          });
        },
        data(client, chunk) {
          if (client.data.upstream) client.data.upstream.write(chunk);
          else client.data.pending.push(new Uint8Array(chunk));
        },
        close(client) {
          open.delete(client);
          client.data.upstream?.end();
        },
        error(client) {
          client.data.upstream?.end();
        },
      },
    });
  };
  listen();

  return {
    url: `redis://127.0.0.1:${port}`,
    cut: () => {
      listener?.stop(true);
      listener = undefined;
      for (const client of open) {
        client.data.upstream?.end();
        client.end();
      }
      open.clear();
    },
    restore: () => {
      if (!listener) listen();
    },
    stop: () => listener?.stop(true),
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

const proxy = redisConfigured ? await makeProxy(new URL(realUrl!)) : undefined;
const direct = redisConfigured ? new RedisClient(realUrl) : undefined;
// Every Redis layer below reads REDIS_URL when it's built: point them at the
// proxy. Each test file runs in its own process, so this stays here.
if (proxy) process.env.REDIS_URL = proxy.url;

afterAll(() => {
  proxy?.stop();
  direct?.close();
});

const fast = <A>(effect: Effect.Effect<A>) =>
  Effect.runPromise(effect.pipe(Effect.timeout(Duration.seconds(1))));

redisTest(
  "a client reconnects after Bun has given up on reconnecting, and says so",
  async () => {
    // One retry: Bun's own reconnecting is over within a second of the cut,
    // after which its client used to stay failed until the process died.
    const redis = supervisedRedis("test-give-up", proxy!.url, {
      maxRetries: 1,
    });
    await redis.ready;
    let reconnects = 0;
    redis.onConnect(
      Effect.sync(() => {
        reconnects++;
      }),
    );

    proxy!.cut();
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(redis.isUp()).toBe(false);
    } finally {
      proxy!.restore();
    }

    expect(await waitFor(() => redis.isUp(), 15_000)).toBe(true);
    expect(await redis.client.ping()).toBe("PONG");
    expect(reconnects).toBe(1);
  },
  30_000,
);

redisTest(
  "rate limits fail fast to per-instance counting while Redis is down, then go back to Redis",
  async () => {
    const redis = supervisedRedis("test-rate-limiter", proxy!.url);
    await redis.ready;
    const limiter = makeRedisRateLimiter(redis);
    const key = `outage-test:${crypto.randomUUID()}`;

    expect((await fast(limiter.consume(key, 2, 60))).allowed).toBe(true);
    expect(await direct!.get(`ratelimit:${key}`)).toBe("1");

    proxy!.cut();
    try {
      await waitFor(() => !redis.isUp(), 5_000);
      // Counted here, and the limit still holds — per instance.
      expect((await fast(limiter.consume(key, 2, 60))).allowed).toBe(true);
      expect((await fast(limiter.consume(key, 2, 60))).allowed).toBe(true);
      expect((await fast(limiter.consume(key, 2, 60))).allowed).toBe(false);
    } finally {
      proxy!.restore();
    }

    expect(await waitFor(() => redis.isUp())).toBe(true);
    await fast(limiter.consume(key, 2, 60));
    expect(await direct!.get(`ratelimit:${key}`)).toBe("2");
  },
  30_000,
);

redisTest(
  "a /ws ticket issued while Redis is down is redeemable once on any instance",
  async () => {
    const secret = "outage-test-secret";
    const fallback = await makeFallbackTickets(secret);
    const issuing = supervisedRedis("test-ws-ticket-a", proxy!.url);
    const redeeming = supervisedRedis("test-ws-ticket-b", proxy!.url);
    await Promise.all([issuing.ready, redeeming.ready]);
    const instanceA = makeRedisWsTicket(issuing, fallback);
    const instanceB = makeRedisWsTicket(
      redeeming,
      await makeFallbackTickets(secret),
    );

    proxy!.cut();
    let ticket: string;
    try {
      await waitFor(() => !issuing.isUp() && !redeeming.isUp(), 5_000);
      ticket = await fast(instanceA.issue(42));
      expect(ticket.startsWith("f1.")).toBe(true);
      // Signed, so the other instance can check it without Redis — and
      // only once.
      expect(await fast(instanceB.consume(ticket))).toBe(42);
      expect(await fast(instanceB.consume(ticket))).toBeNull();
      // Tampered or foreign tickets never pass.
      expect(
        await fast(instanceB.consume(ticket.replace("f1.42.", "f1.43."))),
      ).toBeNull();
      const foreign = await (
        await makeFallbackTickets("another-secret")
      ).issue(42);
      expect(await fast(instanceB.consume(foreign))).toBeNull();
    } finally {
      proxy!.restore();
    }

    // Once Redis is back, a fallback ticket's single use is cluster-wide.
    expect(await waitFor(() => issuing.isUp() && redeeming.isUp())).toBe(true);
    const later = await fast(Effect.promise(() => fallback.issue(7)));
    expect(await fast(instanceA.consume(later))).toBe(7);
    expect(await fast(instanceB.consume(later))).toBeNull();
    // And new tickets are ordinary Redis ones again.
    expect((await fast(instanceA.issue(7))).startsWith("f1.")).toBe(false);
  },
  30_000,
);

// One app instance whose every Redis client goes through the proxy.
const makeInstance = (contacts: ReadonlyArray<readonly [number, number]>) =>
  ManagedRuntime.make(
    RealtimeConnectionsLive.pipe(
      Layer.provideMerge(RedisPubSubLive),
      Layer.provide(RedisUserLocatorLive),
      Layer.provide(RedisPresenceStoreLive),
      Layer.provide(staticPresenceAudience(contacts)),
      Layer.provide(Layer.succeed(ResyncSpread, Duration.millis(50))),
      Layer.provide(
        Layer.succeed(PresenceHeartbeat, {
          interval: Duration.seconds(20),
          deadAfter: Duration.seconds(60),
        }),
      ),
    ),
  );

redisTest(
  "while Redis is down an instance still delivers its own events; once it's back, its sockets resync and presence catches up",
  async () => {
    const userId = Date.now();
    const contactId = userId + 1;
    const instance = makeInstance([[userId, contactId]]);
    try {
      const received: string[] = [];
      const write = (chunk: string) =>
        Effect.sync(() => {
          received.push(chunk);
        });
      await instance.runPromise(
        Effect.gen(function* () {
          const connections = yield* RealtimeConnections;
          yield* connections.register(userId, write);
        }),
      );
      await waitFor(() => received.length > 0, 5_000);
      received.length = 0;

      proxy!.cut();
      try {
        await new Promise((resolve) => setTimeout(resolve, 300));
        // An event for a user on this instance is delivered locally, and
        // promptly — nothing waits on Redis.
        await instance.runPromise(
          Effect.gen(function* () {
            const connections = yield* RealtimeConnections;
            yield* connections.notifyUsers([userId], {
              type: "chat_updated",
              chatId: 1,
              version: 2,
            });
          }).pipe(Effect.timeout(Duration.seconds(1))),
        );
        expect(
          await waitFor(() => received.some((m) => m.includes("chat_updated"))),
        ).toBe(true);
        // A contact connecting during the outage: Redis never hears of it.
        await instance.runPromise(
          Effect.gen(function* () {
            const connections = yield* RealtimeConnections;
            yield* connections.register(contactId, () => Effect.void);
          }).pipe(Effect.timeout(Duration.seconds(1))),
        );
        expect(
          await direct!.hget(presenceCountsKey(contactId), String(contactId)),
        ).toBeNull();
      } finally {
        proxy!.restore();
      }

      // Back: the socket is told to resync and handed a fresh snapshot
      // that includes the contact, whom Redis now counts as online.
      expect(
        await waitFor(() =>
          received.includes(JSON.stringify({ type: "resync" })),
        ),
      ).toBe(true);
      expect(
        await waitFor(() =>
          received.some((m) => {
            const event = JSON.parse(m) as { type: string; userIds?: number[] };
            return (
              event.type === "presence_snapshot" &&
              (event.userIds ?? []).includes(contactId)
            );
          }),
        ),
      ).toBe(true);
      expect(
        await direct!.hget(presenceCountsKey(contactId), String(contactId)),
      ).toBe("1");

      // And its subscription is back: an event published straight to Redis
      // by someone else reaches it.
      received.length = 0;
      await direct!.publish(
        "chat-platform:realtime",
        JSON.stringify({
          scope: "users",
          userIds: [userId],
          event: { type: "chat_updated", chatId: 1, version: 3 },
        }),
      );
      expect(
        await waitFor(() => received.some((m) => m.includes('"version":3'))),
      ).toBe(true);
    } finally {
      await instance.dispose();
    }
  },
  45_000,
);
