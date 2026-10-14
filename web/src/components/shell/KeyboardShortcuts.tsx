import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSession } from "@/lib/auth";
import { openOverlay, openPalette } from "@/lib/shell";

// How long after `g` the second key of a "go to" chord is still accepted.
const CHORD_TIMEOUT_MS = 1200;

// `g` then one of these jumps there (issue #554).
const GO_TO = {
  f: "/",
  c: "/chats",
  n: "/notifications",
  u: "/users",
  g: "/games",
  s: "/settings",
} as const;

// Whether a key press belongs to something the user is typing into, where a
// bare letter must stay a letter.
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The app's global keyboard shortcuts (issue #554). Mounted once at the
 * root, and eagerly: the cheat sheet (`ShortcutsDialog`) and the palette
 * these keys open are lazy chunks (issue #604), but the handler is what has
 * to catch the very first keypress — it only flips the overlay store, and
 * the root mounts whichever overlay that names.
 *
 * `Ctrl/⌘+K` works from anywhere, a text field included — it's the one
 * combination nothing types. The bare-key shortcuts (`/`, `?`, `g …`) are
 * ignored while focus is in a field, and while any modifier other than
 * Shift is held, so they never eat a character or a browser shortcut.
 * Chat-specific keys (`Alt+↑/↓`) live with the chats layout, and composer
 * keys with the composer.
 */
export function KeyboardShortcuts() {
  const session = useSession();
  const navigate = useNavigate();
  const chordAtRef = useRef(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        if (!session) return;
        event.preventDefault();
        openPalette("switcher");
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      // A dialog of its own (confirm, group settings) owns the keyboard.
      if (document.querySelector("[aria-modal=true]")) return;

      const chordPending = Date.now() - chordAtRef.current < CHORD_TIMEOUT_MS;
      chordAtRef.current = 0;
      if (chordPending && event.key in GO_TO) {
        event.preventDefault();
        void navigate({ to: GO_TO[event.key as keyof typeof GO_TO] });
        return;
      }
      if (event.key === "g") {
        chordAtRef.current = Date.now();
      } else if (event.key === "/" && session) {
        event.preventDefault();
        openPalette("search");
      } else if (event.key === "?") {
        event.preventDefault();
        openOverlay("shortcuts");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, session]);

  return null;
}
