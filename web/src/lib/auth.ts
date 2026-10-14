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
    // Every change funnels through here — set/cleared in this tab, another
    // tab's `storage` event, or unreadable data dropped above — so this keeps
    // the boot script's marker true for the page's lifetime.
    markSession(value !== null);
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
  markSession(true);
  emit();
}

export function clearSession(): void {
  window.localStorage.removeItem(STORAGE_KEY);
  markSession(false);
  emit();
}

// `data-session` on <html>: whether a session is stored, set before the
// first paint by `SESSION_BOOT_SCRIPT` and kept current from here. CSS keys
// the prerendered shell's placeholders off it (see `SessionPlaceholder`).
function markSession(signedIn: boolean): void {
  document.documentElement.dataset.session = signedIn ? "in" : "out";
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

const subscribeNever = () => () => {};

// True while React is still hydrating the prerendered SPA shell (and during
// the prerender itself): `useSession()` then reports the server snapshot,
// null, whoever is signed in, so a "signed out" render there may be wrong.
// Session-dependent UI renders `SessionPlaceholder` for that pass instead
// (issue #603); any later render — a fresh mount, the re-render right after
// hydration — knows the real session.
export function useSessionPending(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => false,
    () => true,
  );
}

// Runs inline in <head> next to the theme's boot script, so the marker is on
// <html> before anything paints. It stands alone (it can't import this
// module), so it repeats `isSession` in miniature with the storage key
// written out literally — keep it in step with `STORAGE_KEY` and
// `isSession`. Storage that throws reads as signed out.
export const SESSION_BOOT_SCRIPT =
  '(function(){var s=false;try{var v=JSON.parse(localStorage.getItem("chat-platform-session"));' +
  's=!!v&&typeof v.accessToken==="string"&&typeof v.refreshToken==="string"&&' +
  '!!v.user&&typeof v.user.id==="number"&&typeof v.user.username==="string";}catch(e){}' +
  'document.documentElement.setAttribute("data-session",s?"in":"out");})();';
