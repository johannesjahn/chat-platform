// Typed client for the chat-platform backend. `openapi-fetch` provides the
// runtime fetch client and `openapi-react-query` layers typed React Query hooks
// on top — both driven by the `paths` type generated from the OpenAPI spec
// (see `bun run gen:types`), so requests/responses stay in lockstep with the API.
import createFetchClient from "openapi-fetch";
import createQueryClient from "openapi-react-query";
import { clearSession, getSession, setSession } from "./auth";
import { reportConnectivity } from "./online";
import type { components, paths } from "./api-types";

// `__E2E_API_URL__` is injected by Playwright (see `web/e2e/fixtures.ts`) so
// each e2e test can point the frontend at its own isolated backend instance.
export const API_URL =
  (typeof window !== "undefined" &&
    (window as unknown as { __E2E_API_URL__?: string }).__E2E_API_URL__) ||
  import.meta.env.VITE_API_URL ||
  "http://localhost:3000";

export const fetchClient = createFetchClient<paths>({ baseUrl: API_URL });

// The access token is short-lived (15 minutes, see src/Jwt.ts) — decode its
// `exp` claim (no signature check needed, this is just a client-side timing
// hint) so a request can trigger a refresh *before* the token expires,
// rather than only reacting after the server has already rejected it once.
function accessTokenExpiresAt(accessToken: string): number | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(json) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

const REFRESH_SKEW_MS = 30_000;

// Deduplicates concurrent refreshes — several requests can notice an
// about-to-expire token at once, but only one of them should call
// `/users/refresh` (a refresh token is rotated on use, so a second call with
// the now-stale refresh token would otherwise fail).
let refreshInFlight: Promise<Session | null> | null = null;

function refreshSession(session: Session): Promise<Session | null> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_URL}/users/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    })
      .then(async (response) => {
        if (!response.ok) {
          clearSession();
          return null;
        }
        const { accessToken, refreshToken } = (await response.json()) as {
          accessToken: string;
          refreshToken: string;
        };
        const next: Session = { ...session, accessToken, refreshToken };
        setSession(next);
        return next;
      })
      .catch(() => null) // network error — leave the session alone, might just be offline
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

// Attach the access token to every request so protected endpoints (e.g. the
// user list) are authenticated, and drop the session if the server rejects it.
fetchClient.use({
  async onRequest({ request }) {
    let session = getSession();
    if (session) {
      const expiresAt = accessTokenExpiresAt(session.accessToken);
      if (expiresAt !== null && expiresAt - REFRESH_SKEW_MS <= Date.now()) {
        session = (await refreshSession(session)) ?? session;
      }
      request.headers.set("Authorization", `Bearer ${session.accessToken}`);
    }
    return request;
  },
  onResponse({ response }) {
    // Any response at all — including error statuses — means the request
    // made it to the server and back, so the network path is up right now
    // (see reportConnectivity in lib/online.ts for why this matters more
    // than the browser's own online/offline events).
    reportConnectivity(true);
    if (response.status === 401) clearSession();
    return response;
  },
  onError({ error }) {
    // A deliberately aborted request (component unmount, query cancellation)
    // isn't a connectivity failure — only a genuine network-level failure
    // (the fetch itself rejecting) means we're offline.
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      reportConnectivity(false);
    }
  },
});

// `$api.useQuery("get", "/users/search", ...)`, `$api.useMutation("post", "/users/login")`, …
export const $api = createQueryClient(fetchClient);

// Revokes the session's refresh token server-side, then clears it locally.
// The revoke call is best-effort (fire-and-forget) — a network failure
// shouldn't stop the user from logging out of this device; the token will
// simply outlive its already-cleared client session until it expires.
export function logout(session: Session): void {
  fetchClient
    .POST("/users/logout", {
      body: { refreshToken: session.refreshToken },
    })
    .catch(() => {});
  clearSession();
}

// Prefix of the query key `$api.useQuery("get", "/users/search", ...)`
// generates (openapi-react-query keys queries as `[method, path, init]`).
// `queryClient.invalidateQueries` matches by prefix by default, so this
// invalidates every currently-mounted user search regardless of its query
// text — used after login/register so a freshly-authenticated session's
// searches aren't served stale (previously-disabled) data.
export const usersQueryKey = ["get", "/users/search"] as const;

// Below this, a search isn't narrow enough to be worth sending (mirrors
// `MIN_USER_SEARCH_QUERY_LENGTH` in src/Api.ts) — keeps queries and payloads
// bounded independent of the user base's size (see issue #48).
export const MIN_USER_SEARCH_QUERY_LENGTH = 3;

// Floor for newly chosen passwords (mirrors `MIN_PASSWORD_LENGTH` in
// src/Api.ts) — lets the form reject a too-short password before a round
// trip, matching the server's own validation (issue #45).
export const MIN_PASSWORD_LENGTH = 8;

// Mirrors `MAX_DISPLAY_NAME_LENGTH` in src/Api.ts.
export const MAX_DISPLAY_NAME_LENGTH = 64;

export type PublicUser = components["schemas"]["User"];
export type Session = components["schemas"]["LoginResponse"];
export type Credentials = components["schemas"]["LoginBody"];
