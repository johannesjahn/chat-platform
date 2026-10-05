import { useSyncExternalStore } from "react";
import type { Session } from "./api";

// Client-side session storage. The access token issued by the backend is kept
// in localStorage so the UI can reflect the logged-in user across reloads.
const STORAGE_KEY = "chat-platform-session";

const listeners = new Set<() => void>();

// Cache the parsed value keyed by the raw string so useSyncExternalStore gets a
// stable reference between renders (a fresh JSON.parse each call would loop).
let cache: { raw: string | null; value: Session | null } = {
  raw: null,
  value: null,
};

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw !== cache.raw) {
    const value = raw === null ? null : parseSession(raw);
    // Unreadable data (a manual edit, an extension, a partial write, an old
    // format) is treated as signed out and dropped, rather than throwing
    // during render and keeping the app from loading until storage is
    // cleared by hand (issue #508).
    if (raw !== null && value === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    cache = { raw, value };
  }
  return cache.value;
}

function parseSession(raw: string): Session | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isSession(parsed) ? parsed : null;
}

// A structural check of just what the app relies on — enough that a stored
// value from some other shape can't crash a consumer further down.
function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const { user, accessToken, refreshToken } = value as Record<string, unknown>;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    return false;
  }
  if (typeof user !== "object" || user === null) return false;
  const { id, username } = user as Record<string, unknown>;
  return typeof id === "number" && typeof username === "string";
}

export function setSession(session: Session): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  emit();
}

export function clearSession(): void {
  window.localStorage.removeItem(STORAGE_KEY);
  emit();
}

function emit(): void {
  for (const listener of listeners) listener();
}

// Notified whenever the session may have changed — set/cleared in this tab,
// or (via the `storage` event) in another one. Exported for non-React code
// that has to react to the signed-in user changing (see query.ts).
export function subscribeSession(callback: () => void): () => void {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

export function useSession(): Session | null {
  // Server snapshot is always null — the session lives only in the browser.
  return useSyncExternalStore(subscribeSession, getSession, () => null);
}
