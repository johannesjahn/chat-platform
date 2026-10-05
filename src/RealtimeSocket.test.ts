import { expect, test } from "bun:test";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { Effect } from "effect";
import { ChatApi } from "./Api.ts";
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

const makeClient = HttpApiClient.make(ChatApi, { baseUrl: "http://localhost" });

const registerAndLogin = (username: string) =>
  Effect.gen(function* () {
    const c = yield* makeClient;
    const password = "password123";
    yield* c.users.register({ payload: { username, password } });
    const { accessToken } = yield* c.users.login({
      payload: { username, password },
    });
    return accessToken;
  });

const mintTicket = (accessToken: string) =>
  Effect.gen(function* () {
    const c = yield* HttpApiClient.make(ChatApi, {
      baseUrl: "http://localhost",
      transformClient: (client) =>
        HttpClient.mapRequest(
          client,
          HttpClientRequest.setHeader("Authorization", `Bearer ${accessToken}`),
        ),
    });
    const { ticket } = yield* c.realtime.createWsTicket();
    return ticket;
  });

// The harness can't actually upgrade (see above), so a handshake with a
// valid ticket gets past every check and then fails at the upgrade itself —
// with something other than the 401/403/429 the checks return.
const handshake = (ticket?: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(
      ticket === undefined
        ? "http://localhost/ws"
        : `http://localhost/ws?ticket=${ticket}`,
    );
  });

test("GET /ws handshakes from many users behind one IP aren't throttled together (issue #495)", async () => {
  // Every request in this harness shares one "unknown" IP — standing in for
  // an office/campus/CGNAT address. Five users reconnecting seven times each
  // is 35 handshakes from that IP within the window: more than any one user
  // is allowed (WS_HANDSHAKE_MAX_ATTEMPTS_PER_USER), but each user stays
  // well under it, so none of them may be turned away.
  await run(
    Effect.gen(function* () {
      const tokens: Array<string> = [];
      for (let i = 0; i < 5; i++) {
        tokens.push(yield* registerAndLogin(`shared_ip_${i}`));
      }
      for (let round = 0; round < 7; round++) {
        for (const token of tokens) {
          const response = yield* handshake(yield* mintTicket(token));
          expect(response.status).not.toBe(429);
          expect(response.status).not.toBe(401);
        }
      }
    }),
  );
});

test("GET /ws handshake is rate-limited per user after repeated attempts", async () => {
  // WS_HANDSHAKE_MAX_ATTEMPTS_PER_USER is 30 (RealtimeSocket.ts).
  await run(
    Effect.gen(function* () {
      const token = yield* registerAndLogin("reconnect_loop");
      for (let i = 0; i < 30; i++) {
        const response = yield* handshake(yield* mintTicket(token));
        expect(response.status).not.toBe(429);
      }
      const response = yield* handshake(yield* mintTicket(token));
      expect(response.status).toBe(429);
      expect(response.headers["retry-after"]).toBeDefined();

      // Another user behind the same IP is unaffected.
      const other = yield* registerAndLogin("same_ip_neighbour");
      const otherResponse = yield* handshake(yield* mintTicket(other));
      expect(otherResponse.status).not.toBe(429);
    }),
  );
});

test("GET /ws handshake is still capped per IP as an abuse backstop", async () => {
  // WS_HANDSHAKE_MAX_ATTEMPTS_PER_IP is 300 (RealtimeSocket.ts), checked
  // before the ticket is — so even attempts with no ticket at all (which
  // never reach a per-user bucket) stay bounded per source address. The
  // harness has no real socket, so every call shares one "unknown" IP.
  await run(
    Effect.gen(function* () {
      for (let i = 0; i < 300; i++) {
        const response = yield* handshake();
        expect(response.status).toBe(401);
      }
      const response = yield* handshake();
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
