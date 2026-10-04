import { type ReactNode, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { useSmoothResize, useTransitionState } from "@/lib/motion";
import { cn } from "@/lib/utils";

// A panel that height-animates open and closed — the one way anything in the
// app expands or collapses in place. See `.collapse-panel` in styles.css for
// the motion itself and `useTransitionState` for the lifecycle.
//
// By default the children unmount once the panel has finished closing (so a
// collapsed comment thread stops fetching and re-rendering). `keepMounted`
// keeps them in the DOM, `hidden`, instead — for content another element
// points at with `aria-controls`, or that's cheaper to keep than rebuild.
//
// Once open, it also glides to a new height when its content changes size
// (`useSmoothResize`), so content that loads in after it opens doesn't jump.
//
// While closing (and while closed but kept mounted) the panel is `inert`, so
// focus can't land in content that's on its way out.
export function Collapse({
  open,
  children,
  keepMounted = false,
  id,
  className,
}: {
  open: boolean;
  children: ReactNode;
  keepMounted?: boolean;
  id?: string;
  className?: string;
}) {
  const { ref, phase, mounted, state } =
    useTransitionState<HTMLDivElement>(open);
  const contentRef = useRef<HTMLDivElement | null>(null);
  useSmoothResize(ref, contentRef, phase === "entered");
  if (!mounted && !keepMounted) return null;
  return (
    <div
      ref={ref}
      id={id}
      data-state={state}
      data-settled={phase === "entered" ? "" : undefined}
      hidden={!mounted}
      inert={!open}
      className={cn("collapse-panel", className)}
    >
      <div className="collapse-panel-content">
        {/* What `useSmoothResize` watches. Not the grid item above it: that
            one is sized *by* the panel, so animating the panel would resize
            it and feed back into another animation. This one is only ever
            its children's height (`flow-root` keeps their margins inside). */}
        <div ref={contentRef} className="flow-root">
          {children}
        </div>
      </div>
    </div>
  );
}

// The chevron that reports a disclosure's state: points down closed, half-turns
// up open, on the app's spring.
export function DisclosureChevron({
  open,
  className,
}: {
  open: boolean;
  className?: string;
}) {
  return (
    <ChevronDown
      aria-hidden
      className={cn(
        "disclosure-chevron size-4",
        open && "rotate-180",
        className,
      )}
    />
  );
}
