import { useSyncExternalStore } from "react";

// App-wide overlays that more than one place can open (issue #554): the
// command palette (the sidebar's search button, `Ctrl/⌘+K`, `/`) and the
// keyboard-shortcut cheat sheet (the account menu, `?`). A module-level store
// rather than context, so the global key handler and any button can open
// them without threading a provider through the tree — the same shape as
// lib/presence.ts and lib/typing.ts.

export type ShellOverlay = "palette" | "shortcuts";

let current: ShellOverlay | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

// Opening one overlay closes the other — they're both modal.
export function openOverlay(overlay: ShellOverlay): void {
  if (current === overlay) return;
  current = overlay;
  emit();
}

export function closeOverlay(overlay: ShellOverlay): void {
  if (current !== overlay) return;
  current = null;
  emit();
}

export function useOverlayOpen(overlay: ShellOverlay): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current === overlay,
    () => false,
  );
}

// "⌘" on Apple platforms, "Ctrl" everywhere else — what the hints print.
export function modKeyLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘" : "Ctrl";
}
