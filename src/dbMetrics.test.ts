import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect, Metric } from "effect";
import { ChatApi } from "./Api.ts";
import { makeTestRun } from "./testApi.ts";

// db_query_duration_seconds is labeled by the route template a database
// call ran for (timedDbCall in Db.ts), read off the router's RouteContext —
// so these drive real requests through the API rather than calling dbQuery
// directly, the way Db.test.ts does.
const run = makeTestRun();

// Total calls recorded per "METHOD route", across outcomes. Module-level
// metrics are shared with other test files in the same worker, so the tests
// compare before and after.
const callsByRoute = Effect.map(Metric.snapshot, (pairs) => {
  const counts = new Map<string, number>();
  for (const metric of pairs) {
    if (metric.id !== "db_query_duration_seconds") continue;
    if (metric.type !== "Histogram") continue;
    const key = `${metric.attributes?.["method"]} ${metric.attributes?.["route"]}`;
    counts.set(key, (counts.get(key) ?? 0) + metric.state.count);
  }
  return counts;
});

test("a request's database calls are labeled with its method and route template, never its raw path", () =>
  run(
    Effect.gen(function* () {
      const c = yield* HttpApiClient.make(ChatApi, {
        baseUrl: "http://localhost",
      });
      const before = yield* callsByRoute;

      const user = yield* c.users.register({
        payload: { username: "metrics-user", password: "s3cret-pw" },
      });
      const { accessToken } = yield* c.users.login({
        payload: { username: "metrics-user", password: "s3cret-pw" },
      });
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.execute(
        HttpClientRequest.get(`http://localhost/users/${user.id}`).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
        ),
      );
      expect(response.status).toBe(200);

      const after = yield* callsByRoute;
      const delta = (key: string) =>
        (after.get(key) ?? 0) - (before.get(key) ?? 0);
      expect(delta("POST /users/register")).toBeGreaterThan(0);
      expect(delta("POST /users/login")).toBeGreaterThan(0);
      expect(delta("GET /users/:id")).toBeGreaterThan(0);
      for (const key of after.keys())
        expect(key).not.toContain(`/users/${user.id}`);
    }),
  ));
