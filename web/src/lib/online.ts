import { useSyncExternalStore } from "react";

// Plain `navigator.onLine` + `online`/`offline` listeners — actual network
// connectivity, not to be confused with `useIsOnline` in presence.ts, which
// tracks per-user chat presence (the green dot) over the WS connection.
// `navigator.onLine` reflects the OS/browser's view of the network
// interface (true whenever *some* connection exists, even a broken one), so
// this is a best-effort signal for UI purposes (banner, disabling the
// composer) rather than a guarantee requests will succeed.
function subscribe(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

function getSnapshot(): boolean {
  return navigator.onLine;
}

// SPA-only (see RootDocument in __root.tsx, no SSR) but `navigator` is still
// unavailable during the router's initial server-free prerender pass, so a
// server snapshot is required.
function getServerSnapshot(): boolean {
  return true;
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
