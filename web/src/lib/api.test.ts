/// <reference types="bun" />
import { beforeEach, describe, expect, mock, test } from "bun:test";

// The fetch middleware reads and writes the session through ./auth, which
// needs a browser — stub it with an in-memory one.
type StoredSession = {
  user: { id: number; username: string };
  accessToken: string;
  refreshToken: string;
};
let session: StoredSession | null = null;
let cleared = 0;
mock.module("./auth", () => ({
  getSession: () => session,
  setSession: (next: StoredSession) => {
    session = next;
  },
  clearSession: () => {
    session = null;
    cleared++;
  },
  subscribeSession: () => () => {},
}));
mock.module("./online", () => ({ reportConnectivity: () => {} }));

// openapi-fetch captures `globalThis.fetch` when the client is created, so a
// delegating stub has to be in place before api.ts is imported.
type Handler = (request: Request) => Response | Promise<Response>;
let handler: Handler = () => new Response(null, { status: 500 });
const requests: Request[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  requests.push(request);
  return handler(request);
}) as typeof fetch;

const { fetchClient } = await import("./api");

// An unsigned JWT-shaped token — the client only decodes `exp` from it.
function token(name: string, expiresInSeconds = 900): string {
  const payload = btoa(
    JSON.stringify({ sub: name, exp: Date.now() / 1000 + expiresInSeconds }),
  );
  return `header.${payload}.signature`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const unauthorized = () =>
  json(401, { _tag: "Unauthorized", message: "Unauthorized" });

const OLD = token("old");
const NEW = token("new");

beforeEach(() => {
  session = {
    user: { id: 1, username: "ada" },
    accessToken: OLD,
    refreshToken: "refresh-1",
  };
  cleared = 0;
  requests.length = 0;
});

const bearer = (request: Request) => request.headers.get("Authorization");
const isRefresh = (request: Request) =>
  new URL(request.url).pathname === "/users/refresh";

describe("a 401 Unauthorized", () => {
  test("is refreshed once and transparently replayed", async () => {
    const bodies: unknown[] = [];
    handler = async (request) => {
      if (isRefresh(request)) {
        expect(await request.json()).toEqual({ refreshToken: "refresh-1" });
        return json(200, { accessToken: NEW, refreshToken: "refresh-2" });
      }
      bodies.push(await request.json());
      return bearer(request) === `Bearer ${NEW}`
        ? json(200, { id: 7 })
        : unauthorized();
    };

    const { data, error } = await fetchClient.POST("/posts", {
      body: { contentType: "text", content: "hello" },
    });

    expect(error).toBeUndefined();
    expect(data).toEqual({ id: 7 } as never);
    // The replay carries the same body as the original request.
    const sent = { contentType: "text", content: "hello" };
    expect(bodies).toEqual([sent, sent]);
    expect(requests.filter(isRefresh)).toHaveLength(1);
    expect(session?.accessToken).toBe(NEW);
    expect(session?.refreshToken).toBe("refresh-2");
    expect(cleared).toBe(0);
  });

  test("concurrent rejections share a single refresh", async () => {
    handler = (request) => {
      if (isRefresh(request)) {
        return json(200, { accessToken: NEW, refreshToken: "refresh-2" });
      }
      return bearer(request) === `Bearer ${NEW}`
        ? json(200, [])
        : unauthorized();
    };

    const results = await Promise.all([
      fetchClient.GET("/chats"),
      fetchClient.GET("/chats"),
      fetchClient.GET("/chats"),
    ]);

    for (const { error } of results) expect(error).toBeUndefined();
    expect(requests.filter(isRefresh)).toHaveLength(1);
    expect(cleared).toBe(0);
  });

  test("clears the session when the refresh is rejected", async () => {
    handler = (request) =>
      isRefresh(request)
        ? json(401, { _tag: "InvalidCredentials", message: "nope" })
        : unauthorized();

    const { error, response } = await fetchClient.GET("/chats");

    expect(response.status).toBe(401);
    expect(error).toBeDefined();
    expect(session).toBeNull();
    // Only the original request went out — nothing to replay with.
    expect(requests.filter((r) => !isRefresh(r))).toHaveLength(1);
  });

  test("clears the session when even the refreshed token is rejected", async () => {
    handler = (request) =>
      isRefresh(request)
        ? json(200, { accessToken: NEW, refreshToken: "refresh-2" })
        : unauthorized();

    const { response } = await fetchClient.GET("/chats");

    expect(response.status).toBe(401);
    expect(requests.filter((r) => !isRefresh(r))).toHaveLength(2);
    expect(session).toBeNull();
  });

  test("keeps the session when the refresh can't reach the server", async () => {
    handler = (request) => {
      if (isRefresh(request)) throw new TypeError("Failed to fetch");
      return unauthorized();
    };

    const { response } = await fetchClient.GET("/chats");

    expect(response.status).toBe(401);
    expect(session?.accessToken).toBe(OLD);
    expect(cleared).toBe(0);
  });
});

test("a wrong password (401 InvalidCredentials) keeps the session", async () => {
  handler = () =>
    json(401, {
      _tag: "InvalidCredentials",
      message: "Incorrect current password",
    });

  const { error } = await fetchClient.POST("/users/me/password", {
    body: { currentPassword: "wrong", newPassword: "something-new" },
  });

  expect(error).toEqual({
    _tag: "InvalidCredentials",
    message: "Incorrect current password",
  } as never);
  expect(requests.filter(isRefresh)).toHaveLength(0);
  expect(session?.accessToken).toBe(OLD);
  expect(cleared).toBe(0);
});

test("a 401 to a signed-out request is left alone", async () => {
  session = null;
  handler = () => json(401, { _tag: "InvalidCredentials", message: "nope" });

  const { response } = await fetchClient.POST("/users/login", {
    body: { username: "ada", password: "wrong-password" },
  });

  expect(response.status).toBe(401);
  expect(requests).toHaveLength(1);
  expect(cleared).toBe(0);
});
