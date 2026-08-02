import { useEffect } from "react";

// Pinch-zoom shrinks `visualViewport.height` too — it reports the *zoom
// window*, not the screen — so a zoomed-in reader would otherwise watch the
// app collapse around them. Anything above this scale is treated as "the user
// is zoomed in", and the last un-zoomed height is kept until they zoom back.
const MAX_TRACKED_SCALE = 1.01;

/**
 * Publishes the genuinely-visible viewport height as the `--app-height`
 * custom property on `<html>`.
 *
 * `100dvh` is supposed to be this number and isn't, on exactly the devices
 * that matter most here:
 *
 * - **The on-screen keyboard.** iOS Safari shrinks only the *visual* viewport
 *   when the keyboard opens; the layout viewport — and so `100dvh` — stays at
 *   full height. Android Chrome does the same under its default
 *   `interactive-widget=resizes-visual`. Either way the bottom of a
 *   `100dvh`-tall layout, composer and newest messages included, sits behind
 *   the keyboard.
 * - **The dynamic toolbar.** `dvh` is meant to track Safari's address bar
 *   showing and hiding, but it's only re-resolved once the animation settles
 *   and some transitions are missed entirely, leaving the layout taller than
 *   the screen.
 *
 * Since the chat view deliberately doesn't let the page scroll (#321/#342),
 * there's no dragging your way to the parts that overflow — whatever `100dvh`
 * overshoots by is simply unreachable. `visualViewport` reports what is
 * actually on screen, keyboard and toolbar included, so consumers should
 * prefer it and keep `100dvh` only as the fallback for browsers without the
 * API: `min-h-[var(--app-height,100dvh)]`.
 */
export function useAppHeight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    // No VisualViewport API (or no DOM at all): leave the property unset so
    // the `100dvh` fallback in the CSS keeps applying.
    if (!viewport) return;

    const root = document.documentElement;
    let frame = 0;

    const update = () => {
      if (viewport.scale > MAX_TRACKED_SCALE) return;
      // iOS fires a burst of these while the keyboard and toolbar animate;
      // coalescing into one write per frame keeps that from thrashing layout.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty("--app-height", `${viewport.height}px`);
      });
    };

    update();
    viewport.addEventListener("resize", update);
    // iOS doesn't reliably fire `resize` for every toolbar transition, but it
    // does move the visual viewport — so `scroll` catches the stragglers.
    viewport.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
}
