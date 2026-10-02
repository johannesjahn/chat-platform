import { expect, test } from "bun:test";
import { HttpClient } from "effect/http";
import { Effect } from "effect";
import { RealtimeSocketRouteLive } from "./RealtimeSocket.ts";
import { makeTestRun } from "./testApi.ts";

// These only exercise the pre-upgrade auth checks in RealtimeSocket.ts (the
// paths that return a plain 401 without ever calling
// `HttpServerRequest.upgrade`). The actual WebSocket upgrade needs a real
// `Bun.serve()` request behind it — the shared test harness's fake
// fetch handler used here doesn't provide one — so the full connect/push
// behavior is covered by a real-server test instead (see
// RealtimeSocket.integration.test.ts).
const run = makeTestRun({ routes: RealtimeSocketRouteLive });

test("GET /ws with no ticket is rejected before any upgrade is attempted", async () => {
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/ws");
      expect(response.status).toBe(401);
    }),
  );
});

test("GET /ws with an unknown ticket is rejected", async () => {
  // A ticket that was never issued (or was already consumed — see
  // WsTicket.test.ts for single-use semantics) fails the same as no ticket
  // at all.
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(
        "http://localhost/ws?ticket=not-a-real-ticket",
      );
      expect(response.status).toBe(401);
    }),
  );
});

test("GET /ws handshake is rate-limited per IP after repeated attempts", async () => {
  // WS_HANDSHAKE_MAX_ATTEMPTS_PER_IP is 30 (RealtimeSocket.ts) — the test
  // harness has no real socket, so every call in this test shares one
  // "unknown" IP bucket. No ticket is needed: the rate limit is enforced
  // before the ticket is even checked, same as the Origin check above.
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      for (let i = 0; i < 30; i++) {
        const response = yield* client.get("http://localhost/ws");
        expect(response.status).toBe(401);
      }
      const response = yield* client.get("http://localhost/ws");
      expect(response.status).toBe(429);
      expect(response.headers["retry-after"]).toBeDefined();
    }),
  );
});

test("GET /ws from a disallowed Origin is rejected before the ticket is even checked", async () => {
  // Even with no ticket at all, a request from an origin outside the
  // WEB_ORIGIN allowlist should fail with 403 (Origin check), not the 401 a
  // same-origin/no-Origin request with no ticket would get.
  await run(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("http://localhost/ws", {
        headers: { origin: "https://evil.example" },
      });
      expect(response.status).toBe(403);
    }),
  );
});
