import type { PointerEvent } from "react";

/**
 * The press ripple every button in the app plays (see `ripple-host` /
 * `ripple-wave` in styles.css).
 *
 * It's a DOM effect rather than rendered markup on purpose: `Button` supports
 * `asChild`, which forwards its props onto a caller-supplied child through a
 * Slot — and a Slot takes exactly one child, so adding a ripple element to
 * `Button`'s JSX would break every `<Button asChild><Link/></Button>` call
 * site in the app. Appending the nodes from the pointer handler sidesteps that
 * entirely: whatever element ends up rendered is the one that gets the ripple.
 *
 * The wave is sized to cover the control from wherever it was pressed (twice
 * the distance to the farthest corner), so the circle always finishes by
 * filling the button rather than stopping short on an off-centre press. Both
 * nodes are removed the moment the animation ends, leaving the DOM as it was.
 */
const RIPPLE_HOST_CLASS = "ripple-host";
const RIPPLE_WAVE_CLASS = "ripple-wave";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function spawnRipple(
  target: HTMLElement,
  clientX: number,
  clientY: number,
): void {
  // The reduced-motion block in styles.css already hides the wave, but not
  // creating it at all keeps the DOM clean for anyone reading it (and for a
  // screen reader walking the button's subtree).
  if (prefersReducedMotion()) return;

  const rect = target.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const size =
    2 * Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));

  const host = document.createElement("span");
  host.className = RIPPLE_HOST_CLASS;
  host.setAttribute("aria-hidden", "true");

  const wave = document.createElement("span");
  wave.className = RIPPLE_WAVE_CLASS;
  wave.style.width = `${size}px`;
  wave.style.height = `${size}px`;
  wave.style.left = `${x - size / 2}px`;
  wave.style.top = `${y - size / 2}px`;
  wave.addEventListener("animationend", () => host.remove(), { once: true });

  host.appendChild(wave);
  target.appendChild(host);
}

/**
 * Wraps a component's own `onPointerDown` (if it has one) so the ripple runs
 * alongside it rather than replacing it.
 */
export function withRipple<E extends PointerEvent<HTMLElement>>(
  handler?: (event: E) => void,
): (event: E) => void {
  return (event: E) => {
    handler?.(event);
    spawnRipple(event.currentTarget, event.clientX, event.clientY);
  };
}
