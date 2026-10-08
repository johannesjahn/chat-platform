import { useSyncExternalStore } from "react";

// Tailwind's `lg` breakpoint (64rem = 1024px at the default root size) — the
// line issue #554 draws between the phone/tablet layout and the desktop one.
// Below it nothing changes; at and above it the app grows a sidebar,
// multi-pane views and the rest. CSS reaches the same line with `lg:`; this
// is for the few places that have to decide *structure* (what renders at
// all) rather than just style, like whether `/chats` is one pane or two.
export const DESKTOP_MEDIA_QUERY = "(min-width: 64rem)";

// Whether `query` currently matches, kept live as the window resizes.
// `useSyncExternalStore` so a resize that crosses the breakpoint re-renders
// in the same commit for every subscriber, never tearing between them. The
// server snapshot (the prerendered SPA shell) is the phone layout — the
// mobile-first default — and the client corrects it right after hydration.
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_MEDIA_QUERY);
}
