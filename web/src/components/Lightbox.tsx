import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Loader2, X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type LightboxProps = {
  src: string;
  alt: string;
  onClose: () => void;
};

type Transform = { scale: number; x: number; y: number };

// Zoom limits derived from the image's natural size vs. the viewport (see
// `computeLimits`). `min` is the fit-to-screen scale the viewer opens at,
// `secondary` the double-click/double-tap target, `max` the ceiling for
// wheel/pinch zooming.
type Limits = { min: number; secondary: number; max: number };

const ZOOM_STEP = 1.6;
// Wheel deltas are wildly device-dependent; this maps a "line" of scroll to
// a gentle multiplicative step via `exp(-delta * k)` so trackpads and mice
// both feel proportional instead of one of them jumping a full zoom level.
const WHEEL_ZOOM_SENSITIVITY = 0.0022;
const ARROW_PAN_PX = 80;
const ANIM_MS = 260;
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
// Vertical drag distance (or flick velocity) past which releasing dismisses
// the viewer instead of springing the image back to center.
const DISMISS_DISTANCE_PX = 120;
const DISMISS_VELOCITY = 0.5; // px per ms
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 30;
const HINT_VISIBLE_MS = 3500;

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// The whole zoom model in one place.
//
// `min` never upscales: an image smaller than the viewport opens at 1:1
// rather than blown up and blurry. `secondary` is what a double-click jumps
// to — 1:1 for images too big to fit (the classic "see the actual pixels"
// step), or "fill the viewport" for images that already fit, which is what
// makes small images finally get *bigger* than their original size. `max`
// leaves headroom above that for pinch/wheel, capped so a thumbnail can't be
// stretched into a smear.
function computeLimits(
  natural: { w: number; h: number },
  viewport: { w: number; h: number },
): Limits {
  if (!natural.w || !natural.h || !viewport.w || !viewport.h) {
    return { min: 1, secondary: 1, max: 1 };
  }
  const contain = Math.min(viewport.w / natural.w, viewport.h / natural.h);
  const cover = Math.max(viewport.w / natural.w, viewport.h / natural.h);
  const min = Math.min(contain, 1);
  // Always a real step up from `min`, even for an image whose natural size
  // happens to match the viewport exactly.
  const secondary = Math.max(min * 2, Math.min(Math.max(1, cover), min * 8));
  const max = Math.max(secondary * 1.5, min * 4);
  return { min, secondary, max };
}

// Full-screen image viewer (issue #320).
//
// Feed image posts and image attachments render cropped/thumbnailed in
// place; clicking one opens it here — fit to the screen to start, then
// zoomable and pannable, PhotoSwipe-style, so an image can be inspected far
// beyond its on-page (or even its natural) size:
//
//   - wheel/trackpad zooms toward the cursor when fit, pans once zoomed
//     (ctrl/⌘+wheel always zooms, matching browser pinch-zoom gestures)
//   - double-click / double-tap toggles between fit and 1:1-or-fill
//   - drag to pan when zoomed, pinch to zoom with two fingers
//   - swipe/drag down at fit scale to dismiss, with the backdrop fading out
//   - keyboard: +/-/0 zoom, arrows pan, Esc closes
//
// Rendered through a portal into `document.body`, which is load-bearing
// rather than tidiness: `PostCard`/`MessageBubble` use `backdrop-blur`, and a
// backdrop-filtered element becomes the containing block for `position:
// fixed` descendants — so before the portal this "full-screen" viewer was
// laid out (and clipped) inside the card it opened from, which is why it
// could never show an image any bigger than the post itself.
//
// Deliberately dependency-free otherwise: the gesture math is ~150 lines and
// reuses the app's existing modal chrome (fixed overlay, Escape-to-close,
// focus restore, background scroll lock) instead of pulling in a lightbox
// library and its stylesheet.
export function Lightbox({ src, alt, onClose }: LightboxProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [showHint, setShowHint] = useState(true);
  const [closing, setClosing] = useState(false);
  // Only the coarse, render-visible slice of the transform lives in state —
  // the transform itself is written straight to the element (see `apply`) so
  // dragging and pinching don't re-render on every pointer event.
  const [ui, setUi] = useState({
    zoomed: false,
    canZoomIn: false,
    canZoomOut: false,
  });

  const transform = useRef<Transform>(IDENTITY);
  const limits = useRef<Limits>({ min: 1, secondary: 1, max: 1 });
  const naturalRef = useRef<{ w: number; h: number } | null>(null);
  const viewportRef = useRef({ w: 0, h: 0 });
  const entranceDone = useRef(false);
  const closedRef = useRef(false);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const closeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const setBackdropOpacity = (opacity: number, animate = false) => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    backdrop.style.transition = animate
      ? `opacity ${ANIM_MS}ms ease-out`
      : "none";
    backdrop.style.opacity = String(opacity);
  };

  const apply = useCallback((next: Transform, animate: boolean) => {
    transform.current = next;
    const img = imgRef.current;
    if (img) {
      // Written as a whole (not just `transitionProperty`) so it also keeps
      // the fade-in of the image itself, which the class-based transition
      // would otherwise lose to this assignment.
      img.style.transition =
        animate && !prefersReducedMotion()
          ? `transform ${ANIM_MS}ms ${EASE}, opacity 300ms ease-out`
          : "opacity 300ms ease-out";
      // `translate(-50%, -50%)` centers the element on the container's
      // midpoint whatever its natural size is; the px translate is applied
      // after the scale, so panning stays in screen pixels at every zoom.
      img.style.transform = `translate(-50%, -50%) translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`;
    }
    const { min, max } = limits.current;
    const zoomed = next.scale > min * 1.01;
    setUi((prev) => {
      const canZoomIn = next.scale < max * 0.99;
      if (
        prev.zoomed === zoomed &&
        prev.canZoomIn === canZoomIn &&
        prev.canZoomOut === zoomed
      ) {
        return prev;
      }
      return { zoomed, canZoomIn, canZoomOut: zoomed };
    });
  }, []);

  // Keeps the image inside sane bounds: never smaller than fit, and never
  // dragged so far that its edge crosses into the viewport (axes where the
  // scaled image is smaller than the viewport stay centered).
  const clampTransform = useCallback((next: Transform): Transform => {
    const { min, max } = limits.current;
    const scale = clamp(next.scale, min, max);
    const n = naturalRef.current;
    if (!n) return { scale, x: 0, y: 0 };
    const maxX = Math.max(0, (n.w * scale - viewportRef.current.w) / 2);
    const maxY = Math.max(0, (n.h * scale - viewportRef.current.h) / 2);
    return {
      scale,
      x: clamp(next.x, -maxX, maxX),
      y: clamp(next.y, -maxY, maxY),
    };
  }, []);

  const commit = useCallback(
    (next: Transform, animate = false) => apply(clampTransform(next), animate),
    [apply, clampTransform],
  );

  // Zooms to `scale` while keeping the image point under (clientX, clientY)
  // pinned to that spot — the difference between "zoom toward my cursor" and
  // "zoom to the middle and then go hunting".
  const zoomTo = useCallback(
    (scale: number, clientX?: number, clientY?: number, animate = true) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const px =
        (clientX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
      const py =
        (clientY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
      const current = transform.current;
      const target = clamp(scale, limits.current.min, limits.current.max);
      const factor = target / current.scale;
      commit(
        {
          scale: target,
          x: px - (px - current.x) * factor,
          y: py - (py - current.y) * factor,
        },
        animate,
      );
    },
    [commit],
  );

  const toggleZoom = useCallback(
    (clientX?: number, clientY?: number) => {
      const { min, secondary } = limits.current;
      const zoomedIn = transform.current.scale > min * 1.01;
      zoomTo(zoomedIn ? min : secondary, clientX, clientY);
    },
    [zoomTo],
  );

  const requestClose = useCallback((direction: 1 | -1 | 0 = 0) => {
    if (closedRef.current) return;
    closedRef.current = true;
    const img = imgRef.current;
    if (img && !prefersReducedMotion()) {
      // Carry a dismiss swipe through in the direction it was headed
      // instead of snapping the image away.
      const t = transform.current;
      const offset = direction === 0 ? 0 : direction * 140;
      img.style.transition = `transform ${ANIM_MS}ms ${EASE}, opacity ${ANIM_MS}ms ease-out`;
      img.style.transform = `translate(-50%, -50%) translate3d(${t.x}px, ${t.y + offset}px, 0) scale(${t.scale * (direction === 0 ? 0.94 : 0.88)})`;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(
      () => onCloseRef.current(),
      prefersReducedMotion() ? 0 : ANIM_MS - 60,
    );
  }, []);

  // Track the container's size (i.e. the viewport) so the fit scale and pan
  // bounds survive rotation, window resizes and mobile browser chrome.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const rect = container.getBoundingClientRect();
      if (
        rect.width === viewportRef.current.w &&
        rect.height === viewportRef.current.h
      ) {
        // ResizeObserver also fires once on `observe()`; ignoring a
        // no-op size keeps it from cutting the open animation short.
        return;
      }
      viewportRef.current = { w: rect.width, h: rect.height };
      const n = naturalRef.current;
      if (!n) return;
      const wasFit = transform.current.scale <= limits.current.min * 1.01;
      limits.current = computeLimits(n, viewportRef.current);
      commit(
        wasFit ? { scale: limits.current.min, x: 0, y: 0 } : transform.current,
        false,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [commit]);

  // First paint once the natural size is known: settle into fit scale with a
  // small zoom-in flourish.
  //
  // The flourish needs the start scale to be painted before the transition
  // to the end scale is armed, hence the rAF hop. `entranceDone` (rather
  // than a "did this effect already run" flag) is what guards it, so a
  // cancelled first pass — StrictMode mounts every effect twice in dev —
  // replays the entrance instead of leaving the image parked at 92%.
  useLayoutEffect(() => {
    if (!natural) return;
    if (!viewportRef.current.w) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) viewportRef.current = { w: rect.width, h: rect.height };
    }
    naturalRef.current = natural;
    limits.current = computeLimits(natural, viewportRef.current);
    const fit = { scale: limits.current.min, x: 0, y: 0 };
    if (entranceDone.current || prefersReducedMotion()) {
      apply(fit, false);
      return;
    }
    apply({ ...fit, scale: fit.scale * 0.92 }, false);
    const frame = requestAnimationFrame(() => {
      entranceDone.current = true;
      apply(fit, true);
    });
    return () => cancelAnimationFrame(frame);
  }, [natural, apply]);

  // Escape/zoom/pan keyboard shortcuts, background scroll lock, focus
  // restore — the modal chrome shared with the app's other dialogs.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    containerRef.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          requestClose();
          return;
        case "+":
        case "=":
          e.preventDefault();
          zoomTo(transform.current.scale * ZOOM_STEP);
          return;
        case "-":
        case "_":
          e.preventDefault();
          zoomTo(transform.current.scale / ZOOM_STEP);
          return;
        case "0":
          e.preventDefault();
          zoomTo(limits.current.min);
          return;
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown": {
          if (transform.current.scale <= limits.current.min * 1.01) return;
          e.preventDefault();
          const dx =
            e.key === "ArrowLeft"
              ? ARROW_PAN_PX
              : e.key === "ArrowRight"
                ? -ARROW_PAN_PX
                : 0;
          const dy =
            e.key === "ArrowUp"
              ? ARROW_PAN_PX
              : e.key === "ArrowDown"
                ? -ARROW_PAN_PX
                : 0;
          const t = transform.current;
          commit({ scale: t.scale, x: t.x + dx, y: t.y + dy }, true);
          return;
        }
        case "Tab": {
          // Minimal focus trap: keep Tab cycling through the viewer's own
          // controls rather than wandering into the page behind it.
          const container = containerRef.current;
          if (!container) return;
          const focusable = container.querySelectorAll<HTMLElement>(
            "button:not([disabled])",
          );
          if (focusable.length === 0) return;
          const first = focusable[0]!;
          const last = focusable[focusable.length - 1]!;
          const active = document.activeElement;
          if (e.shiftKey && (active === first || active === container)) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
          }
          return;
        }
      }
    };

    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [commit, requestClose, zoomTo]);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowHint(false), HINT_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Wheel has to be a non-passive native listener to be able to
  // `preventDefault()` the page/browser zoom underneath it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!naturalRef.current) return;
      e.preventDefault();
      const t = transform.current;
      const zoomGesture =
        e.ctrlKey || e.metaKey || t.scale <= limits.current.min * 1.01;
      if (zoomGesture) {
        const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
        zoomTo(t.scale * factor, e.clientX, e.clientY, false);
      } else {
        // Zoomed in: the wheel scrolls the image, which is what the old
        // viewer couldn't do at all.
        commit({ scale: t.scale, x: t.x - e.deltaX, y: t.y - e.deltaY }, false);
      }
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [commit, zoomTo]);

  // --- Pointer gestures: pan, pinch, drag-to-dismiss, double-tap ----------

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    mode: "pan" | "pinch" | "dismiss";
    start: Transform;
    startX: number;
    startY: number;
    startDistance: number;
    startMidX: number;
    startMidY: number;
    startTime: number;
    moved: boolean;
  } | null>(null);
  const lastTap = useRef({ time: 0, x: 0, y: 0 });

  const beginSinglePointerGesture = (x: number, y: number) => {
    const zoomedIn = transform.current.scale > limits.current.min * 1.01;
    gesture.current = {
      mode: zoomedIn ? "pan" : "dismiss",
      start: transform.current,
      startX: x,
      startY: y,
      startDistance: 0,
      startMidX: x,
      startMidY: y,
      startTime: performance.now(),
      moved: false,
    };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!naturalRef.current) return;
    // Never let a toolbar press turn into a drag gesture — capturing the
    // pointer there would also swallow the button's own click.
    if ((e.target as HTMLElement).closest("button")) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const points = [...pointers.current.values()];
    if (points.length === 1) {
      beginSinglePointerGesture(e.clientX, e.clientY);
    } else if (points.length === 2) {
      const [a, b] = points as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      gesture.current = {
        mode: "pinch",
        start: transform.current,
        startX: e.clientX,
        startY: e.clientY,
        startDistance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        startMidX: (a.x + b.x) / 2,
        startMidY: (a.y + b.y) / 2,
        startTime: performance.now(),
        moved: false,
      };
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    if (g.mode === "pinch") {
      const points = [...pointers.current.values()];
      if (points.length < 2) return;
      const [a, b] = points as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const factor = distance / g.startDistance;
      const scale = clamp(
        g.start.scale * factor,
        limits.current.min,
        limits.current.max,
      );
      const applied = scale / g.start.scale;
      // Anchor on the pinch midpoint and let it drag the image along, so a
      // two-finger gesture zooms and pans in one motion.
      const p0x = g.startMidX - centerX;
      const p0y = g.startMidY - centerY;
      const p1x = (a.x + b.x) / 2 - centerX;
      const p1y = (a.y + b.y) / 2 - centerY;
      g.moved = true;
      commit(
        {
          scale,
          x: p1x - (p0x - g.start.x) * applied,
          y: p1y - (p0y - g.start.y) * applied,
        },
        false,
      );
      return;
    }

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) > 4) g.moved = true;

    if (g.mode === "pan") {
      commit(
        { scale: g.start.scale, x: g.start.x + dx, y: g.start.y + dy },
        false,
      );
      return;
    }

    // Dismiss drag: follow the finger 1:1, shrinking the image and fading
    // the backdrop as it goes so the gesture reads as "throwing it away".
    if (!g.moved) return;
    const progress = Math.min(1, Math.abs(dy) / (DISMISS_DISTANCE_PX * 2.5));
    apply(
      {
        scale: g.start.scale * (1 - progress * 0.2),
        x: g.start.x + dx,
        y: g.start.y + dy,
      },
      false,
    );
    setBackdropOpacity(1 - progress * 0.75);
  };

  const endPointer = (e: ReactPointerEvent) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (!g) return;

    if (g.mode === "pinch") {
      const remaining = [...pointers.current.values()];
      if (remaining.length === 1) {
        // Lifting one finger of a pinch continues as a pan from wherever
        // the image now sits — no jump.
        const [p] = remaining as [{ x: number; y: number }];
        beginSinglePointerGesture(p.x, p.y);
      } else {
        gesture.current = null;
        commit(transform.current, true);
      }
      return;
    }

    if (pointers.current.size > 0) return;
    gesture.current = null;

    if (g.mode === "dismiss") {
      const dy = e.clientY - g.startY;
      const elapsed = Math.max(1, performance.now() - g.startTime);
      const velocity = dy / elapsed;
      if (
        g.moved &&
        (Math.abs(dy) > DISMISS_DISTANCE_PX ||
          Math.abs(velocity) > DISMISS_VELOCITY)
      ) {
        requestClose(dy >= 0 ? 1 : -1);
        return;
      }
      setBackdropOpacity(1, true);
      commit({ scale: limits.current.min, x: 0, y: 0 }, true);
    } else {
      commit(transform.current, true);
    }

    if (!g.moved && e.pointerType !== "mouse") {
      const now = performance.now();
      const isDoubleTap =
        now - lastTap.current.time < DOUBLE_TAP_MS &&
        Math.hypot(
          e.clientX - lastTap.current.x,
          e.clientY - lastTap.current.y,
        ) < DOUBLE_TAP_SLOP_PX;
      if (isDoubleTap) {
        lastTap.current = { time: 0, x: 0, y: 0 };
        toggleZoom(e.clientX, e.clientY);
      } else {
        lastTap.current = { time: now, x: e.clientX, y: e.clientY };
      }
    }
  };

  const onBackdropClick = () => {
    // A drag that happens to end over the backdrop still fires a click —
    // only treat it as a dismiss if the pointer never really moved.
    if (gesture.current?.moved) return;
    requestClose();
  };

  const zoomed = ui.zoomed;

  return createPortal(
    <div
      ref={containerRef}
      tabIndex={-1}
      className={cn(
        "fixed inset-0 z-50 touch-none overflow-hidden outline-none select-none",
        closing && "pointer-events-none opacity-0 transition-opacity",
      )}
      style={closing ? { transitionDuration: `${ANIM_MS}ms` } : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Image"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
    >
      <div
        ref={backdropRef}
        className="absolute inset-0 bg-background/92 backdrop-blur-md motion-safe:animate-backdrop-blur-in"
        onClick={onBackdropClick}
      />

      {status === "loading" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      )}
      {status === "failed" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">
            This image couldn&apos;t be loaded.
          </p>
        </div>
      )}

      {/* Sized to the image's natural pixels and scaled purely by transform:
          the browser keeps resampling from the full-resolution bitmap, so
          zooming in stays as sharp as the source allows. */}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(e) => {
          const el = e.currentTarget;
          setNatural({ w: el.naturalWidth, h: el.naturalHeight });
          setStatus("ready");
        }}
        onError={() => setStatus("failed")}
        onDoubleClick={(e) => {
          e.preventDefault();
          toggleZoom(e.clientX, e.clientY);
        }}
        className={cn(
          "absolute top-1/2 left-1/2 max-w-none origin-center shadow-2xl",
          status === "ready" ? "opacity-100" : "opacity-0",
          zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
        )}
        style={
          natural
            ? { width: natural.w, height: natural.h }
            : { width: 1, height: 1 }
        }
      />

      {/* The floating controls spring open with the overlay rather than being
          there already — see `animate-pop-open`. */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-full bg-background/70 p-1 shadow-lg ring-1 ring-border/50 backdrop-blur-sm motion-safe:animate-pop-open sm:top-4 sm:right-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full"
          disabled={!ui.canZoomOut}
          onClick={() => zoomTo(transform.current.scale / ZOOM_STEP)}
          aria-label="Zoom out"
        >
          <ZoomOut className="size-5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full"
          disabled={!ui.canZoomIn}
          onClick={() => zoomTo(transform.current.scale * ZOOM_STEP)}
          aria-label="Zoom in"
        >
          <ZoomIn className="size-5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full"
          onClick={() => requestClose()}
          aria-label="Close image"
        >
          <X className="size-5" />
        </Button>
      </div>

      <p
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-4 hidden justify-center text-xs text-muted-foreground transition-opacity duration-500 sm:flex",
          showHint && status === "ready" ? "opacity-100" : "opacity-0",
        )}
      >
        <span className="rounded-full bg-background/70 px-3 py-1.5 ring-1 ring-border/50 backdrop-blur-sm">
          Scroll or double-click to zoom · drag to pan · Esc to close
        </span>
      </p>
    </div>,
    document.body,
  );
}
