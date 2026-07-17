// Shared helpers for the k6 scripts in scripts/loadtest/ — see
// scripts/loadtest/README.md for how to run them and what they assume about
// the target backend.
import http from "k6/http";
import { check } from "k6";

export const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(
  /\/$/,
  "",
);

// Derived from BASE_URL rather than a separate env var in the common case —
// only override WS_URL directly if the WebSocket upgrade is reachable at a
// different host/port than the REST API (e.g. behind different ingress
// rules).
export const WS_URL = __ENV.WS_URL || BASE_URL.replace(/^http/, "ws");

const JSON_HEADERS = { "Content-Type": "application/json" };

export const authHeaders = (accessToken) => ({
  ...JSON_HEADERS,
  Authorization: `Bearer ${accessToken}`,
});

// Fixed and well over MIN_PASSWORD_LENGTH (see src/Api.ts) — every load-test
// account shares this password since none of it is real user data.
export const TEST_PASSWORD = "LoadTest-12345";

// Registers `username` if it doesn't already exist, otherwise logs it in —
// either way returns {id, username, accessToken}. Idempotent across runs on
// purpose: /users/register is capped at 5 attempts per source IP per hour
// (see UsersHandler.ts), which a k6 run driving from a single machine would
// blow through immediately if every run tried to create fresh accounts. By
// registering once and logging in on every later run against the same
// backend, only the very first run against a given target spends any of
// that budget — see scripts/loadtest/README.md.
export function loginOrRegister(username) {
  const registerRes = http.post(
    `${BASE_URL}/users/register`,
    JSON.stringify({ username, password: TEST_PASSWORD }),
    { headers: JSON_HEADERS, tags: { name: "register" } },
  );
  if (registerRes.status !== 201 && registerRes.status !== 409) {
    throw new Error(
      `loginOrRegister(${username}): register failed with ${registerRes.status}: ${registerRes.body}`,
    );
  }

  const loginRes = http.post(
    `${BASE_URL}/users/login`,
    JSON.stringify({ username, password: TEST_PASSWORD }),
    { headers: JSON_HEADERS, tags: { name: "login" } },
  );
  check(loginRes, { "login succeeded": (r) => r.status === 200 });
  if (loginRes.status !== 200) {
    throw new Error(
      `loginOrRegister(${username}): login failed with ${loginRes.status}: ${loginRes.body}`,
    );
  }

  const body = loginRes.json();
  return { id: body.user.id, username, accessToken: body.accessToken };
}

// Mints a single-use /ws ticket (see src/WsTicket.ts) for `accessToken`'s
// user — the WebSocket handshake itself can't carry an Authorization header.
export function mintWsTicket(accessToken) {
  const res = http.post(`${BASE_URL}/realtime/ws-ticket`, null, {
    headers: authHeaders(accessToken),
    tags: { name: "createWsTicket" },
  });
  check(res, { "ws ticket minted": (r) => r.status === 201 });
  if (res.status !== 201) {
    throw new Error(`mintWsTicket: failed with ${res.status}: ${res.body}`);
  }
  return res.json().ticket;
}

export function randomText(prefix, wordLength = 32) {
  return `${prefix} ${Math.random()
    .toString(36)
    .slice(2, 2 + wordLength)}`;
}
