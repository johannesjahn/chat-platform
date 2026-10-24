import type { Session } from "./api";

// What a refresher needs from the outside world — passed in rather than
// imported so the cross-tab behaviour can be unit-tested without a browser.
export type SessionRefreshDeps = {
  readonly apiUrl: string;
  readonly getSession: () => Session | null;
  readonly setSession: (session: Session) => void;
  readonly clearSession: () => void;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly locks: Pick<LockManager, "request"> | undefined;
};

// Every tab shares the one session in localStorage, so they all see the same
// expiry and would otherwise all refresh the same token at once — and the
// server treats a refresh token presented twice as stolen and logs the user
// out everywhere (issue #650). A Web Lock lets one tab at a time refresh; the
// rest wait, then find it already done.
export const REFRESH_LOCK = "chat-platform-session-refresh";

export function createSessionRefresher(deps: SessionRefreshDeps) {
  // Deduplicates concurrent refreshes within this tab — several requests can
  // notice an about-to-expire token at once, but only one of them should
  // call `/users/refresh`.
  let inFlight: Promise<Session | null> | null = null;

  const withLock = <T>(fn: () => Promise<T>): Promise<T> =>
    deps.locks ? deps.locks.request(REFRESH_LOCK, fn) : fn();

  async function refreshUnderLock(stale: Session): Promise<Session | null> {
    // Re-read the session: while this tab waited for the lock, another one
    // may have rotated the token (nothing to do — use what it stored) or
    // signed out.
    const session = deps.getSession();
    if (!session) return null;
    if (session.refreshToken !== stale.refreshToken) return session;
    try {
      const response = await deps.fetch(`${deps.apiUrl}/users/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      if (!response.ok) {
        deps.clearSession();
        return null;
      }
      const { accessToken, refreshToken } = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
      };
      const next: Session = { ...session, accessToken, refreshToken };
      deps.setSession(next);
      return next;
    } catch {
      return null; // network error — leave the session alone, might just be offline
    }
  }

  return (stale: Session): Promise<Session | null> => {
    inFlight ??= withLock(() => refreshUnderLock(stale)).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
