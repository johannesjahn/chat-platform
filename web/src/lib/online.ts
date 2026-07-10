import { onlineManager } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

// Plain connectivity signal — not to be confused with `useIsOnline` in
// presence.ts, which tracks per-user chat presence (the green dot) over the
// WS connection.
//
// Backed by React Query's own `onlineManager` (the same thing `networkMode:
// "online"` queries pause/resume on — see query.ts) rather than reading
// `navigator.onLine` directly, so this hook and React Query's fetch-pausing
// always agree on whether we're "online" right now.
//
// Two things `onlineManager` gets wrong on its own, that this file corrects:
//
//  1. It only listens for the browser's `online`/`offline` *events* — it
//     never reads `navigator.onLine` itself, and its internal default is
//     hardcoded `true`. So a page loaded while already offline (no
//     online->offline transition ever happens) leaves it reporting "online"
//     until some other event flips it, and the very first query fires for
//     real instead of pausing — surfacing a raw "Failed to fetch" instead of
//     the offline UI. The `setOnline(navigator.onLine)` call below, run once
//     at module load (i.e. app boot), seeds it correctly from the start.
//  2. Browser online/offline events only reflect whether *some* network
//     interface is up, not whether requests to our own server actually
//     succeed — in some environments (notably an installed/standalone PWA)
//     they can also lag behind or simply never fire when connectivity
//     actually changes mid-session. `reportConnectivity` (called from the
//     fetch client's middleware — see api.ts) corrects this from real
//     request outcomes instead: any response completing means the network
//     path to the server is up right now, and a network-level fetch failure
//     means it isn't, regardless of what the browser events say.
export function reportConnectivity(isOnline: boolean): void {
  onlineManager.setOnline(isOnline);
}

if (typeof navigator !== "undefined") {
  onlineManager.setOnline(navigator.onLine);
}

function getSnapshot(): boolean {
  return onlineManager.isOnline();
}

// SPA-only (see RootDocument in __root.tsx, no SSR) but `onlineManager`'s
// browser listeners aren't attached during the router's initial
// server-free prerender pass, so a server snapshot is required.
function getServerSnapshot(): boolean {
  return true;
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    getSnapshot,
    getServerSnapshot,
  );
}
