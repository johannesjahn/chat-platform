import { useEffect, useRef, useState } from "react";

/**
 * Drives the one-shot "pop" a brand mark plays when the control it sits in is
 * clicked (see `animate-logo-press` in styles.css).
 *
 * The press has to be observed on the surrounding control rather than on the
 * mark itself: the nav's icons live inside buttons and links whose whole box
 * is the click target, so a press on the label next to the icon has to animate
 * it too. The hook therefore walks up to the nearest `<a>`/`<button>` and
 * listens there, falling back to the marked element when it stands alone.
 *
 * Returns a ref for the animated element, whether the press animation should
 * currently be applied, and the handler that clears it again — wire that to
 * the element's `onAnimationEnd` so the class is only present while it runs
 * and every later press can re-apply it.
 */
export function useLogoPress<T extends Element>() {
  const ref = useRef<T>(null);
  const [pressed, setPressed] = useState(false);

  useEffect(() => {
    const element = ref.current;
    const control = element?.closest("a, button") ?? element;
    if (!control) return;

    let frame = 0;
    const press = () => {
      // Dropping the class and re-adding it a frame later is what restarts a
      // still-running animation — re-setting the same state would keep the
      // class on the element, and CSS only replays an animation whose name
      // was actually removed in between.
      setPressed(false);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setPressed(true));
    };
    // `pointerdown` fires the pop the instant the mark is pushed rather than
    // on release, but never for a keyboard activation — that arrives as a
    // click with no originating pointer, which is exactly what `detail === 0`
    // identifies. Real mouse clicks carry a click count, so they can't
    // double-trigger through both listeners.
    const onClick = (event: Event) => {
      if ((event as MouseEvent).detail === 0) press();
    };

    control.addEventListener("pointerdown", press);
    control.addEventListener("click", onClick);
    return () => {
      cancelAnimationFrame(frame);
      control.removeEventListener("pointerdown", press);
      control.removeEventListener("click", onClick);
    };
  }, []);

  return { ref, pressed, endPress: () => setPressed(false) };
}
