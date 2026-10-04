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
    cache = { raw, value: raw ? (JSON.parse(raw) as Session) : null };
  }
  return cache.value;
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
