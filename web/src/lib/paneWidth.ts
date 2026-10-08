import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";

// The chat list pane's bounds, in px, and how far an arrow key moves it.
const MIN_WIDTH = 260;
const MAX_WIDTH = 520;
const KEY_STEP = 16;

function clamp(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

function stored(key: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? clamp(value) : null;
  } catch {
    return null;
  }
}

function save(key: string, width: number | null) {
  try {
    if (width === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(width));
  } catch {
    // Without storage the width just won't outlive the page.
  }
}

/**
 * A pane the user can resize by dragging (or arrow-keying) its edge — the
 * desktop chat list (issue #554) — remembered per device. `width` is null
 * until the user has resized it, so the pane keeps its responsive default
 * (`w-80 xl:w-96`) until then; double-clicking the handle goes back to it.
 */
export function useResizablePane(storageKey: string) {
  const [width, setWidth] = useState<number | null>(() => stored(storageKey));
  const paneRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const commit = (next: number | null) => {
    setWidth(next);
    save(storageKey, next);
  };

  const handleProps = {
    role: "separator",
    "aria-orientation": "vertical" as const,
    "aria-label": "Resize chat list",
    "aria-valuemin": MIN_WIDTH,
    "aria-valuemax": MAX_WIDTH,
    "aria-valuenow": width ?? undefined,
    tabIndex: 0,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      const pane = paneRef.current;
      if (!pane || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        startX: event.clientX,
        startWidth: pane.getBoundingClientRect().width,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      setWidth(clamp(drag.startWidth + event.clientX - drag.startX));
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      const pane = paneRef.current;
      if (pane) commit(clamp(pane.getBoundingClientRect().width));
    },
    onDoubleClick: () => commit(null),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const current =
        width ?? paneRef.current?.getBoundingClientRect().width ?? MIN_WIDTH;
      commit(
        clamp(current + (event.key === "ArrowRight" ? KEY_STEP : -KEY_STEP)),
      );
    },
  };

  return { width, paneRef, handleProps };
}
