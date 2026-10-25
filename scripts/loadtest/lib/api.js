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

// Google ID tokens for the load-test accounts, keyed by username — written by
// `bun run loadtest:tokens` (scripts/loadtest/mint-google-tokens.ts), since
// k6 can't sign RS256 tokens itself. Read in the init context, as `open`
// requires; the path is relative to this file.
const GOOGLE_ID_TOKENS = JSON.parse(
  open(__ENV.GOOGLE_ID_TOKENS_FILE || "../google-id-tokens.json"),
);

const postJson = (path, body, name, expectedStatuses) =>
  http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: JSON_HEADERS,
    tags: { name },
    responseCallback: http.expectedStatuses(...expectedStatuses),
  });

// Signs `username`'s Google account in, picking that username first if the
// account doesn't exist yet — either way returns {id, username, accessToken}.
// Idempotent across runs on purpose: the username step is capped at 5 per
// source IP per hour (see UsersHandler.ts), which a k6 run driving from a
// single machine would blow through immediately if every run created fresh
// accounts. By signing up once and just signing in on every later run against
// the same backend, only the very first run against a given target spends
// any of that budget — see scripts/loadtest/README.md.
export function loginOrRegister(username) {
  const idToken = GOOGLE_ID_TOKENS[username];
  if (!idToken) {
    throw new Error(
      `loginOrRegister(${username}): no ID token for it — run \`bun run loadtest:tokens\` with a count covering it`,
    );
  }

  const loginRes = postJson(
    "/users/login/google",
    { idToken },
    "loginGoogle",
    [200],
  );
  check(loginRes, { "google sign-in succeeded": (r) => r.status === 200 });
  if (loginRes.status !== 200) {
    throw new Error(
      `loginOrRegister(${username}): Google sign-in failed with ${loginRes.status}: ${loginRes.body}`,
    );
  }

  let session = loginRes.json();
  if (session.needsUsername) {
    const registerRes = postJson(
      "/users/register/google",
      { pendingToken: session.pendingToken, username },
      "registerGoogle",
      [201],
    );
    if (registerRes.status !== 201) {
      throw new Error(
        `loginOrRegister(${username}): username step failed with ${registerRes.status}: ${registerRes.body}`,
      );
    }
    session = registerRes.json();
  }
  return { id: session.user.id, username, accessToken: session.accessToken };
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
  // A single Math.random().toString(36) draw only ever yields ~11-13 base36
  // chars, well short of any wordLength much past that — loop until there's
  // enough, then trim to the exact requested length.
  let word = "";
  while (word.length < wordLength) {
    word += Math.random().toString(36).slice(2);
  }
  return `${prefix} ${word.slice(0, wordLength)}`;
}
