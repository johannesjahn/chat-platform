import { expect, test } from "bun:test";
import { HttpClient } from "effect/http";
import { Effect, Layer } from "effect";
import { Db, type DrizzleDb } from "./Db.ts";
import { HealthRouteLive, ReadyRouteLive } from "./Health.ts";
import { PubSub } from "./PubSub.ts";
import { makeTestRun } from "./testApi.ts";

// /health and /ready are raw routes attached to the same shared router as
// `ChatApi` (see Health.ts), served here through the shared test harness.
const routes = Layer.mergeAll(HealthRouteLive, ReadyRouteLive);

// A Db layer whose `execute` always rejects, standing in for a DB that's up
// at the TCP level but not actually queryable — the case /ready exists to
// catch.
const brokenDbLive = Layer.succeed(Db, {
  execute: () => Promise.reject(new Error("db unreachable")),
} as unknown as DrizzleDb);

const brokenPubSubLive = Layer.succeed(PubSub, {
  publish: () => Effect.void,
  subscribe: () => Effect.void,
  ping: Effect.fail(new Error("redis unreachable")),
});

const run = makeTestRun({ routes });
const runWithBrokenDb = makeTestRun({ routes, db: brokenDbLive });
const runWithBrokenPubSub = makeTestRun({ routes, pubSub: brokenPubSubLive });

test("GET /health always reports ok, with no dependency checks", async () => {
  await runWithBrokenDb(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/health");
      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("ok");
    }),
  );
});

test("GET /ready reports ok once the DB and PubSub are reachable", async () => {
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/ready");
      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("ok");
    }),
  );
});

test("GET /ready reports 503 when the DB is unreachable", async () => {
  await runWithBrokenDb(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/ready");
      expect(response.status).toBe(503);
    }),
  );
});

test("GET /ready reports 503 when PubSub is unreachable", async () => {
  await runWithBrokenPubSub(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/ready");
      expect(response.status).toBe(503);
    }),
  );
});
