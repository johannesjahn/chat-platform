import { expect, test } from "bun:test";
import net from "node:net";
import { Duration, Effect } from "effect";
import { makeRedisRateLimiter } from "./RateLimiter.ts";
import { supervisedRedis } from "./redisConnection.ts";
import { makeFallbackTickets, makeRedisWsTicket } from "./WsTicket.ts";

// Issue #832: with Redis unreachable from the start — here, a port nothing
// listens on — the app boots and serves from instance-local state, and
// nothing waits on Redis. RedisOutage.integration.test.ts covers losing a
// real Redis and getting it back.

async function closedPort(): Promise<string> {
  const port = await new Promise<number>((resolve, reject) => {
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
  return `redis://127.0.0.1:${port}`;
}

const fast = <A>(effect: Effect.Effect<A>) =>
  Effect.runPromise(effect.pipe(Effect.timeout(Duration.seconds(1))));

test("a client for an unreachable Redis is ready at once, and down", async () => {
  const redis = supervisedRedis("test-unreachable", await closedPort());
  const started = Date.now();
  await redis.ready;
  expect(Date.now() - started).toBeLessThan(2_500);
  expect(redis.isUp()).toBe(false);
});

test("rate limits are counted per instance without Redis", async () => {
  const limiter = makeRedisRateLimiter(
    supervisedRedis("test-unreachable", await closedPort()),
  );
  const consume = async () => (await fast(limiter.consume("k", 2, 60))).allowed;
  expect([await consume(), await consume(), await consume()]).toEqual([
    true,
    true,
    false,
  ]);
  // Two refunds take the count from 3 back to 1: one more fits, then not.
  await fast(limiter.refund("k"));
  await fast(limiter.refund("k"));
  expect([await consume(), await consume()]).toEqual([true, false]);
  await fast(limiter.reset("k"));
  expect(await consume()).toBe(true);
});

test("without Redis, /ws tickets are signed and redeemable once", async () => {
  const tickets = makeRedisWsTicket(
    supervisedRedis("test-unreachable", await closedPort()),
    await makeFallbackTickets("secret"),
  );
  const ticket = await fast(tickets.issue(5));
  expect(ticket.startsWith("f1.")).toBe(true);
  expect(await fast(tickets.consume(ticket))).toBe(5);
  expect(await fast(tickets.consume(ticket))).toBeNull();
  // A ticket from Redis can't be checked without it.
  expect(await fast(tickets.consume(crypto.randomUUID()))).toBeNull();
});

test("a fallback ticket is rejected once expired, tampered with, malformed or signed with another secret", async () => {
  const fallback = await makeFallbackTickets("secret");
  const now = Date.now();
  const ticket = await fallback.issue(9, now);
  expect(await fallback.verify(ticket, now)).toMatchObject({ userId: 9 });
  expect(await fallback.verify(ticket, now + 31_000)).toBeNull();

  const [prefix, user, expires, nonce, signature] = ticket.split(".") as [
    string,
    string,
    string,
    string,
    string,
  ];
  for (const forged of [
    [prefix, "10", expires, nonce, signature],
    [prefix, user, String(Number(expires) + 60_000), nonce, signature],
    [prefix, user, expires, crypto.randomUUID(), signature],
    [prefix, user, expires, nonce, "AAAA"],
    [prefix, user, expires, nonce],
    [prefix, "x", expires, nonce, signature],
  ]) {
    expect(await fallback.verify(forged.join("."), now)).toBeNull();
  }
  const other = await makeFallbackTickets("another-secret");
  expect(await other.verify(ticket, now)).toBeNull();
  expect(await fallback.verify(crypto.randomUUID(), now)).toBeNull();
});
