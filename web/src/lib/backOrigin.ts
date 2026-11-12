// Where each history entry was opened from (issue #762), so a page's back
// control can say where it goes — "Back to search" — and return there with
// `history.back()` (the previous page keeps its scroll position) instead of
// a hard-coded link to the feed.
//
// Keyed by the router's per-entry `__TSR_key`, recorded the first time an
// entry loads: going back and forward revisits entries that are already
// recorded, so their origin stays the page that opened them rather than
// whichever page was last on screen. Kept in sessionStorage, like the
// router's own scroll restoration, so a reload still knows the origin.

import type { AnyRouter, ParsedLocation } from "@tanstack/react-router";

const STORAGE_KEY = "back-origins";
// Only recent entries matter; the oldest are dropped past this.
const MAX_ENTRIES = 100;

let origins: Map<string, string> | null = null;

function load(): Map<string, string> {
  if (origins) return origins;
  origins = new Map();
  try {
    const raw =
      typeof sessionStorage === "undefined"
        ? null
        : sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      for (const pair of parsed) {
        if (
          Array.isArray(pair) &&
          typeof pair[0] === "string" &&
          typeof pair[1] === "string"
        )
          origins.set(pair[0], pair[1]);
      }
    }
  } catch {
    // Unavailable or corrupt storage: start empty, labels fall back to "Back".
  }
  return origins;
}

function save(map: Map<string, string>) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...map]));
  } catch {
    // Storage full or blocked: the in-memory map still serves this page load.
  }
}

function entryKey(location: ParsedLocation): string | undefined {
  return location.state.__TSR_key;
}

/** Records, for each newly visited entry, the href it was opened from. */
export function trackBackOrigins(router: AnyRouter) {
  router.subscribe("onBeforeLoad", ({ fromLocation, toLocation }) => {
    if (!fromLocation) return; // The first load: nothing came before it.
    const key = entryKey(toLocation);
    if (!key || key === entryKey(fromLocation)) return;
    const map = load();
    if (map.has(key)) return; // Back/forward to an entry we already know.
    map.set(key, fromLocation.href);
    while (map.size > MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    save(map);
  });
}

/** The in-app href the entry `location` was opened from, if it's known. */
export function backOrigin(location: ParsedLocation): string | undefined {
  const key = entryKey(location);
  return key ? load().get(key) : undefined;
}

function pathnameOf(href: string): string {
  return href.split(/[?#]/, 1)[0] ?? href;
}

/**
 * Whether `history.back()` is somewhere worth going: there's an in-app entry
 * before this one, and it isn't the login/register page that sent the user
 * here — that page forwards a signed-in visitor straight back (see
 * `redirectIfSignedIn`), so Back would just bounce.
 */
export function canGoBackTo(
  router: AnyRouter,
  origin: string | undefined,
): boolean {
  return (
    router.history.canGoBack() &&
    (origin === undefined ||
      !/^\/(login|register)\/?$/.test(pathnameOf(origin)))
  );
}

/**
 * The back control's label for a page opened from `origin` (an href) — the
 * place `history.back()` returns to. An unknown origin is just "Back".
 */
export function backLabel(origin: string | undefined): string {
  if (origin === undefined) return "Back";
  return labelFor(pathnameOf(origin));
}

function labelFor(origin: string): string {
  if (origin === "/") return "Back to feed";
  if (origin === "/search") return "Back to search";
  if (origin === "/notifications") return "Back to notifications";
  if (origin === "/users") return "Back to users";
  if (/^\/users\/[^/]+\/?$/.test(origin)) return "Back to profile";
  if (origin === "/chats") return "Back to chats";
  if (/^\/chats\/[^/]+/.test(origin)) return "Back to chat";
  if (/^\/posts\/[^/]+\/?$/.test(origin)) return "Back to post";
  return "Back";
}
