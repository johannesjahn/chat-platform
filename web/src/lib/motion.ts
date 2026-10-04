import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

// The script side of the app's disclosure motion — see "Disclosure motion" in
// styles.css, which owns every duration and curve these hooks play out.

export type TransitionPhase =
  | "exited" // closed and settled: nothing to render (or rendered `hidden`)
  | "preEnter" // mounted for one layout pass in the closed state
  | "entering"
  | "entered"
  | "exiting";

// Resolves once every finite CSS animation/transition currently running on
// `el` itself (not its subtree — a child's hover transition shouldn't hold a
// panel open) has finished. With reduced motion there is nothing running, so
// it resolves straight away, which is what makes the instant fallback free.
function animationsSettled(el: Element): Promise<unknown> {
  if (typeof el.getAnimations !== "function") return Promise.resolve();
  const running = el
    .getAnimations()
    .filter(
      (animation) => animation.effect?.getComputedTiming().endTime !== Infinity,
    );
  return Promise.all(running.map((animation) => animation.finished));
}

// Tracks a disclosure through its whole life instead of just `open`, so a
// panel or menu can stay mounted long enough to animate *out*, and knows when
// it has finished animating *in*.
//
// `open` flipping mid-flight never restarts anything: `exiting` goes straight
// back to `entering`, and because the styles are CSS transitions the element
// turns around from wherever it currently is. The phase only advances to
// `entered`/`exited` once the element's own animations report finished.
//
// Coming from `exited` there is one extra `preEnter` pass: the element is
// committed in its closed styles and the layout flushed, so the browser has a
// starting point to transition *from* — otherwise it would simply appear in
// its open styles.
export function useTransitionState<T extends Element>(open: boolean) {
  const ref = useRef<T | null>(null);
  const [phase, setPhase] = useState<TransitionPhase>(
    open ? "entered" : "exited",
  );
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setPhase(phase === "exited" ? "preEnter" : "entering");
    else if (phase !== "exited") setPhase("exiting");
  }

  useLayoutEffect(() => {
    if (phase !== "preEnter") return;
    // Reading layout forces the closed styles to be computed before the
    // re-render below swaps in the open ones, all ahead of the first paint.
    ref.current?.getBoundingClientRect();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the measure-then-rerender-before-paint case layout effects exist for: the closed styles must be committed and computed first, or there is nothing to transition from.
    setPhase("entering");
  }, [phase]);

  useEffect(() => {
    if (phase !== "entering" && phase !== "exiting") return;
    const settledPhase = phase === "entering" ? "entered" : "exited";
    const el = ref.current;
    if (!el) {
      setPhase(settledPhase);
      return;
    }
    let current = true;
    animationsSettled(el).then(
      () => {
        if (current) setPhase(settledPhase);
      },
      // A cancelled animation means the element was removed or retargeted —
      // whichever phase change did that has its own effect run now.
      () => {},
    );
    return () => {
      current = false;
    };
  }, [phase]);

  return {
    ref,
    phase,
    // Whether there's anything to render at all.
    mounted: phase !== "exited",
    // The state the element should *look* like right now.
    state: (phase === "entering" || phase === "entered" ? "open" : "closed") as
      "open" | "closed",
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Reads one of the `--motion-*` duration tokens off :root, in milliseconds.
function motionDuration(token: "--motion-expand" | "--motion-collapse") {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return raw.endsWith("ms") ? value : value * 1000;
}

function motionEasing(
  token: "--motion-ease-expand" | "--motion-ease-collapse",
) {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(token).trim() ||
    "ease"
  );
}

const RESIZE_ANIMATION_ID = "smooth-resize";

// Keeps an open panel from jumping when its content changes size under it —
// replies arriving after a thread opens, a composer appearing inside it. A
// ResizeObserver reports the content's new height after layout but before
// paint, which is exactly when the panel can be wound back to the old height
// and animated to the new one without a single frame at either size it
// shouldn't be. A change that lands mid-animation starts from the height
// currently on screen, so a burst of updates reads as one continuous glide.
export function useSmoothResize(
  outerRef: RefObject<HTMLElement | null>,
  innerRef: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!active || !outer || !inner || typeof ResizeObserver === "undefined") {
      return;
    }
    let last = inner.getBoundingClientRect().height;
    const resizeAnimations = () =>
      outer.getAnimations().filter((a) => a.id === RESIZE_ANIMATION_ID);

    const observer = new ResizeObserver(() => {
      const next = inner.getBoundingClientRect().height;
      const delta = next - last;
      last = next;
      if (Math.abs(delta) < 1 || prefersReducedMotion()) return;

      const running = resizeAnimations();
      const shown = outer.getBoundingClientRect().height;
      // With nothing running the panel has already laid out at its new size,
      // so where it was is that minus the change.
      const from = running.length > 0 ? shown : shown - delta;
      for (const animation of running) animation.cancel();
      const to = outer.getBoundingClientRect().height;

      const grows = to > from;
      const animation = outer.animate(
        [
          { height: `${from}px`, overflow: "hidden" },
          { height: `${to}px`, overflow: "hidden" },
        ],
        {
          duration: motionDuration(
            grows ? "--motion-expand" : "--motion-collapse",
          ),
          easing: motionEasing(
            grows ? "--motion-ease-expand" : "--motion-ease-collapse",
          ),
        },
      );
      animation.id = RESIZE_ANIMATION_ID;
    });
    observer.observe(inner);
    return () => {
      observer.disconnect();
      for (const animation of resizeAnimations()) animation.cancel();
    };
  }, [outerRef, innerRef, active]);
}

// "Show more"/"Show less" for text cut down with a `line-clamp-*` class,
// animated between the clamped and the full height instead of snapping.
//
// A clamp can't be transitioned in CSS — the two heights it toggles between
// are both `auto` — so this measures them and plays the change with the Web
// Animations API on the same tokens `<Collapse>` uses. The ordering is what
// keeps it from jumping:
//
// - Expanding drops the clamp first (so the full text is laid out), then
//   grows the box from the clamped height to it.
// - Collapsing keeps the full text while the box shrinks to the clamped
//   height, and only clamps it (ellipsis and all) once it gets there.
//   Clamping first would cut the text off while the box was still tall.
//
// Attach `ref` to the clamped element and apply `clampClassName` while
// `clamped`; render the toggle's label/chevron from `expanded`, which flips
// immediately.
export function useExpandableText<T extends HTMLElement>(
  initiallyExpanded: boolean,
  clampClassName: string,
) {
  const ref = useRef<T | null>(null);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  // Lags `expanded` while a collapse is in flight (see above).
  const [clamped, setClamped] = useState(!initiallyExpanded);
  const run = useRef(0);

  function toggle() {
    const el = ref.current;
    const next = !expanded;
    const token = ++run.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== "function") {
      setExpanded(next);
      setClamped(!next);
      return;
    }

    // Measured *before* cancelling, so a toggle mid-animation starts from the
    // height currently on screen and turns around smoothly.
    const from = el.getBoundingClientRect().height;
    for (const animation of el.getAnimations()) animation.cancel();

    let to: number;
    if (next) {
      flushSync(() => {
        setExpanded(true);
        setClamped(false);
      });
      to = el.getBoundingClientRect().height;
    } else {
      flushSync(() => setExpanded(false));
      const classes = clampClassName.split(/\s+/).filter(Boolean);
      el.classList.add(...classes);
      to = el.getBoundingClientRect().height;
      el.classList.remove(...classes);
    }

    const animation = el.animate(
      [
        { height: `${from}px`, overflow: "hidden" },
        { height: `${to}px`, overflow: "hidden" },
      ],
      {
        duration: motionDuration(
          next ? "--motion-expand" : "--motion-collapse",
        ),
        easing: motionEasing(
          next ? "--motion-ease-expand" : "--motion-ease-collapse",
        ),
        // Held at the end until the clamp is applied below, so there's no
        // frame where the box springs back to the full height in between.
        fill: "forwards",
      },
    );
    animation.finished.then(
      () => {
        if (token !== run.current) return;
        if (!next) flushSync(() => setClamped(true));
        animation.cancel();
      },
      () => {},
    );
  }

  return { ref, expanded, clamped, toggle };
}
