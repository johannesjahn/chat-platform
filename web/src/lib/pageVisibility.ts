import { useSyncExternalStore } from "react";

// Whether the page is actually on screen: false while the tab is in the
// background or the window is minimised (issue #663). An open conversation
// only marks messages read while this is true, so what arrives while the
// user is away stays unread — the sender doesn't see ✓✓ and the unread and
// tab-title badges show it — until they come back to the tab.
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
    () => document.visibilityState === "visible",
    // SPA-only, but the router's prerender pass needs a server snapshot.
    () => true,
  );
}
