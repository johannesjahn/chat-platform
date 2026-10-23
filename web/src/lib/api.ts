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

// A copy of each authenticated request as it was before it was sent, keyed by
// openapi-fetch's per-request id — sending consumes a request's body, so this
// is what a replay after a reactive refresh (below) is built from.
const replayable = new Map<string, Request>();

// The `_tag` of a 401's error body. The bearer middleware's rejection is
// `Unauthorized` (src/Auth.ts) — the access token is no good; an endpoint
// that checks a password (change password, delete account) answers a wrong
// one with `InvalidCredentials`, which says nothing about the session.
async function unauthorizedTag(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { _tag?: unknown };
    return typeof body._tag === "string" ? body._tag : null;
  } catch {
    return null;
  }
}

// The server rejected `sent`'s access token — most likely it expired sooner
// than this device's clock thought (clock skew, or a request in flight across
// the expiry). Refresh once (single-flight, via `refreshSession`) and replay
// the request with the new token. Returns the replay's response, or null if
// there's nothing to replay with (the original response then stands).
async function refreshAndReplay(
  sent: Request,
  copy: Request,
  doFetch: typeof fetch,
): Promise<Response | null> {
  const session = getSession();
  if (!session) return null;
  const sentToken = sent.headers.get("Authorization")?.replace(/^Bearer /, "");
  // Another request may already have refreshed while this one was out — then
  // the stored token is the new one and it's only a matter of replaying.
  const next =
    session.accessToken === sentToken ? await refreshSession(session) : session;
  // A failed refresh has already cleared the session; a network error leaves
  // it alone (might just be offline) — either way there's no replay.
  if (!next) return null;
  copy.headers.set("Authorization", `Bearer ${next.accessToken}`);
  const response = await doFetch(copy);
  // Rejected even with a freshly issued token: the session really is dead
  // (e.g. revoked by a password change on another device).
  if (
    response.status === 401 &&
    (await unauthorizedTag(response)) === "Unauthorized"
  ) {
    clearSession();
  }
  return response;
}

// Attach the access token to every request so protected endpoints (e.g. the
// user list) are authenticated. A 401 `Unauthorized` gets one refresh and a
// replay before the session is given up on (issue #656).
fetchClient.use({
  async onRequest({ request, id }) {
    let session = getSession();
    if (session) {
      const expiresAt = accessTokenExpiresAt(session.accessToken);
      if (expiresAt !== null && expiresAt - REFRESH_SKEW_MS <= Date.now()) {
        session = (await refreshSession(session)) ?? session;
      }
      request.headers.set("Authorization", `Bearer ${session.accessToken}`);
      replayable.set(id, request.clone());
    }
    return request;
  },
  async onResponse({ request, response, options, id }) {
    // Any response at all — including error statuses — means the request
    // made it to the server and back, so the network path is up right now
    // (see reportConnectivity in lib/online.ts for why this matters more
    // than the browser's own online/offline events).
    reportConnectivity(true);
    const copy = replayable.get(id);
    replayable.delete(id);
    if (response.status !== 401 || !copy) return response;
    // Only the bearer middleware's rejection means the session is in doubt —
    // a wrong password on a signed-in endpoint must leave it alone.
    if ((await unauthorizedTag(response)) !== "Unauthorized") return response;
    return (await refreshAndReplay(request, copy, options.fetch)) ?? response;
  },
  onError({ error, id }) {
    replayable.delete(id);
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

// Query key openapi-react-query generates for the current user's block/mute
// list (`$api.useQuery("get", "/users/me/blocks")`) — invalidated after any
// block/mute/unblock so the settings card and profile controls refresh.
export const blocksQueryKey = ["get", "/users/me/blocks"] as const;

// Below this, a search isn't narrow enough to be worth sending for a regular
// user (mirrors `MIN_USER_SEARCH_QUERY_LENGTH` in src/Api.ts) — keeps queries
// and payloads bounded independent of the user base's size (see issue #48).
// Admins are exempt and may search — or list everyone — with a shorter
// (including empty) query.
export const MIN_USER_SEARCH_QUERY_LENGTH = 3;

// Floor for newly registered usernames (mirrors `MIN_USERNAME_LENGTH` in
// src/Api.ts) — the same as the people-search floor above, so every account
// can be found (issue #483).
export const MIN_USERNAME_LENGTH = 3;

// Characters a newly registered username may use (mirrors `USERNAME_PATTERN`
// in src/Api.ts, issue #493): the `@mention` token class from
// `MENTION_CHARS` in lib/mentions.ts, not ending in "." or "-" (which the
// mention parser trims off as punctuation) — so every new account can be
// @mentioned. Register only; existing names still log in.
export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]*[A-Za-z0-9_]$/u;

// Floor for newly chosen passwords (mirrors `MIN_PASSWORD_LENGTH` in
// src/Api.ts) — lets the form reject a too-short password before a round
// trip, matching the server's own validation (issue #45).
export const MIN_PASSWORD_LENGTH = 8;

// Mirrors `MAX_DISPLAY_NAME_LENGTH` in src/Api.ts.
export const MAX_DISPLAY_NAME_LENGTH = 64;

// Mirrors `MAX_BIO_LENGTH` in src/Api.ts (issue #322).
export const MAX_BIO_LENGTH = 160;

// Mirrors `MAX_STATUS_TEXT_LENGTH`/`MAX_STATUS_EMOJI_LENGTH` in src/Api.ts
// (issue #218).
export const MAX_STATUS_TEXT_LENGTH = 100;
export const MAX_STATUS_EMOJI_LENGTH = 8;

export type PublicUser = components["schemas"]["User"];
export type Session = components["schemas"]["LoginResponse"];
export type Credentials = components["schemas"]["LoginBody"];
export type BlockedUser = components["schemas"]["BlockedUser"];
export type BlockType = components["schemas"]["BlockType"];
