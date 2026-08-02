import { useEffect } from "react";

// Pinch-zoom shrinks `visualViewport.height` too — it reports the *zoom
// window*, not the screen — so a zoomed-in reader would otherwise watch the
// app collapse around them. Anything above this scale is treated as "the user
// is zoomed in", and the last un-zoomed height is kept until they zoom back.
const MAX_TRACKED_SCALE = 1.01;

/**
 * Publishes the genuinely-visible viewport as the `--app-height` and
 * `--app-offset-top` custom properties on `<html>`.
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
 *
 * `--app-offset-top` is the other half of the same story: iOS doesn't only
 * shrink the visual viewport, it *pans* it over the layout viewport to keep a
 * focused field clear of the keyboard. Anything anchored to the layout
 * viewport — a `position: fixed` element, which is how the immersive shell
 * pins the app — then sits that far above the band the user can actually see.
 * The offset is what puts it back.
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
        root.style.setProperty("--app-offset-top", `${viewport.offsetTop}px`);
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

// Attribute (on `<html>`) the immersive rules in styles.css hang off. Kept
// here so the hook and the stylesheet can't drift apart silently.
const SHELL_ATTRIBUTE = "data-app-shell";

/**
 * Switches the document into the "immersive" app shell for as long as
 * `active` is true — see the `[data-app-shell="immersive"]` rules in
 * styles.css for what that actually changes.
 *
 * The conversation view is the one screen that is an *app*, not a document:
 * a fixed header, a thread that scrolls inside itself, and a composer pinned
 * to the bottom edge. Two things have to be true for that to survive a phone,
 * and neither is true of the ordinary layout:
 *
 * - **The page itself must not scroll.** `<body>` is otherwise
 *   `min-h-[var(--app-height,…)]`, a *minimum*: the moment the layout comes
 *   out a few pixels taller than the visible viewport — a safe-area inset, a
 *   toolbar mid-transition, a composer grown to two lines — the page becomes
 *   scrollable and the whole app slides under the sticky nav, which is
 *   exactly the drift visible on a real device. Immersive pins the height
 *   *exactly* to what's on screen and takes `<body>` out of flow with
 *   `position: fixed`, so the document has nothing left to scroll at all —
 *   `overflow: hidden` alone doesn't get there, since iOS still drags a
 *   viewport that says it's hidden.
 * - **The site nav can't eat the space.** It's ~145px on a phone (three
 *   wrapped rows), more once `env(safe-area-inset-top)` is added. That's
 *   affordable at full height and ruinous when the on-screen keyboard has
 *   left ~400px: header, pinned bar and composer alone fill it, collapsing
 *   the thread to nothing — no messages visible at all while typing. So on
 *   phone widths the conversation hides it and keeps its own header (with
 *   its back button) as the only chrome, the way every native messenger
 *   does.
 */
export function useImmersiveShell(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.setAttribute(SHELL_ATTRIBUTE, "immersive");
    return () => root.removeAttribute(SHELL_ATTRIBUTE);
  }, [active]);
}
