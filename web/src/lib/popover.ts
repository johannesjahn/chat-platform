import { useEffect, useId, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useTransitionState } from "./motion";

/**
 * The open/close plumbing for a trigger-anchored popover (the desktop account
 * menu, the notifications panel): what ComposerAttachMenu does inline, made
 * reusable.
 *
 * - It remembers the location it was opened on rather than a bare boolean —
 *   the phone menu's trick in __root.tsx — so any navigation, including one
 *   started from inside the panel, closes it.
 * - A press anywhere outside `rootRef` dismisses it; Escape closes it and puts
 *   focus back on the trigger it came from.
 * - It stays mounted while it animates out (`useTransitionState`), so the
 *   caller renders while `mounted` and picks `animate-pop-close` while
 *   `phase === "exiting"`.
 */
//
// Callers destructure the result rather than holding on to it: it carries
// refs, and the React compiler's lint treats reading anything off an object
// that holds refs as reading a ref during render.
export function usePopover<Panel extends HTMLElement = HTMLDivElement>() {
  const href = useRouterState({ select: (s) => s.location.href });
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === href;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const transition = useTransitionState<Panel>(open);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) {
        setOpenAt(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenAt(null);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return {
    open,
    setOpen: (next: boolean) => setOpenAt(next ? href : null),
    toggle: () => setOpenAt(open ? null : href),
    rootRef,
    triggerRef,
    panelRef: transition.ref,
    panelId,
    mounted: transition.mounted,
    exiting: transition.phase === "exiting",
  };
}
