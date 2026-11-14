import { type TouchEvent, useEffect, useRef, useState } from "react";

/**
 * Touch equivalent of the desktop hover-reveal (issue #309). The per-message
 * action group (react/pin/star/reply/edit/delete) is otherwise only shown on
 * `group-hover`, which touch devices never produce — so on phones/tablets it
 * was completely unreachable. A long press on the bubble reveals the same
 * group, mirroring the long-press-to-react gesture of most mobile messaging
 * apps; desktop hover behaviour is left untouched. A desktop right-click
 * reveals it too (issue #554). Split out of MessageBubble in issue #811;
 * `rowRef` is the message's row, which a tap outside of puts the group away.
 */
export function useBubbleReveal(
  rowRef: React.RefObject<HTMLDivElement | null>,
  isEditing: boolean,
) {
  const [revealed, setRevealed] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // Set once the long press actually fires, so the follow-up `contextmenu`
  // event (which mobile browsers emit on a long press) can be suppressed
  // without also swallowing a genuine desktop right-click.
  const longPressFired = useRef(false);

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Cancel any pending timer if the bubble unmounts mid-press.
  useEffect(() => clearLongPress, []);

  // While the touch-revealed group is showing, dismiss it when the next tap
  // lands outside this message row (the reaction popover itself portals to
  // document.body, so picking an emoji counts as "outside" and collapses the
  // group too — which is the desired outcome once a reaction is chosen).
  //
  // A desktop right-click reveals the same group (issue #554) and is put
  // away the same way, or with Escape.
  useEffect(() => {
    if (!revealed) return;
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (rowRef.current && !rowRef.current.contains(target)) {
        setRevealed(false);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setRevealed(false);
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [revealed, rowRef]);

  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (isEditing) return;
    const touch = e.touches[0];
    if (!touch) return;
    touchStart.current = { x: touch.clientX, y: touch.clientY };
    longPressFired.current = false;
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      longPressTimer.current = null;
      setRevealed(true);
      // A short haptic cue on trigger where supported (unsupported on e.g.
      // iOS Safari, hence the capability check rather than optional-call).
      if (typeof navigator.vibrate === "function") navigator.vibrate(10);
    }, 450);
  };

  const onTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    const start = touchStart.current;
    const touch = e.touches[0];
    if (!start || !touch) return;
    // A finger that travels more than a few pixels is a scroll, not a press —
    // cancel so the picker never pops up mid-scroll.
    if (
      Math.abs(touch.clientX - start.x) > 10 ||
      Math.abs(touch.clientY - start.y) > 10
    ) {
      clearLongPress();
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    // Suppress the browser's own long-press context menu on touch.
    if (longPressFired.current) {
      e.preventDefault();
      return;
    }
    // A desktop right-click opens the message's actions, the way the
    // long press does on touch (issue #554) — except on a link, a
    // picture or player, or over selected text, where the browser's
    // own menu (copy link, save image, copy) is what's wanted.
    if (isEditing) return;
    const target = e.target as Element;
    if (target.closest("a, img, video, audio, button")) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
    setRevealed(true);
  };

  return {
    revealed,
    // Spread onto the bubble.
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd: clearLongPress,
      onTouchCancel: clearLongPress,
      onContextMenu,
    },
  };
}
