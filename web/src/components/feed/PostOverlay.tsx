import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { ExternalLink, X } from "lucide-react";
import { PostDetail } from "@/components/PostDetail";
import { Button } from "@/components/ui/button";
import { useTransitionState } from "@/lib/motion";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The desktop overlay a post opens in from the feed (issue #561): the post's
// full view in a panel on the right, over the feed rather than instead of it,
// so closing it puts the reader back exactly where they were. The feed route
// owns *whether* it's open (its `?post=` search param, masked in the address
// bar as `/posts/$id`); this owns the dialog chrome — Escape, the backdrop
// and the close button all call `onClose`, focus moves in on open and back
// to the post's card on close, Tab stays inside, and the page underneath
// doesn't scroll.
//
// `postId` going undefined closes it; the last post stays rendered while the
// panel slides out.
export function PostOverlay({
  postId,
  onClose,
}: {
  postId: number | undefined;
  onClose: () => void;
}) {
  const open = postId !== undefined;
  const [shownId, setShownId] = useState(postId);
  if (postId !== undefined && postId !== shownId) setShownId(postId);

  const titleId = useId();
  const {
    ref: panelRef,
    phase,
    mounted,
  } = useTransitionState<HTMLDivElement>(open);

  // Focus moves into the panel (its close button — the post itself isn't
  // a control) and, on close, back to the post's card in the feed
  // underneath: its "Open post" link, looked up by post id since a click
  // doesn't focus a link in every browser. Failing that (the post was
  // deleted), whatever was focused before.
  useEffect(() => {
    if (!open || shownId === undefined) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current
      ?.querySelector<HTMLElement>("[data-overlay-close]")
      ?.focus({ preventScroll: true });
    return () => {
      const target =
        document.querySelector<HTMLElement>(
          `[data-post-id="${shownId}"] [data-open-post]`,
        ) ?? (previouslyFocused?.isConnected ? previouslyFocused : null);
      target?.focus({ preventScroll: true });
    };
  }, [open, shownId, panelRef]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // On the panel rather than `window`, and only for keys pressed inside it:
  // a lightbox or a confirm dialog opened from the post sits in its own
  // portal and handles its own Escape — this must not close underneath it.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel || !panel.contains(event.target as Node)) return;
    if (event.key === "Escape") {
      if (event.defaultPrevented) return;
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...panel.querySelectorAll<HTMLElement>(FOCUSABLE),
    ].filter((el) => el.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!mounted || shownId === undefined) return null;
  const exiting = phase === "exiting";
  const id = String(shownId);

  // Portalled out of the page column: that column is its own stacking
  // context (its view-transition name), which would otherwise leave the
  // overlay underneath the sidebar however high its z-index.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      inert={!open}
      onKeyDown={onKeyDown}
    >
      <div
        data-testid="post-overlay-backdrop"
        className={cn(
          "absolute inset-0 bg-background/60 backdrop-blur-sm",
          exiting
            ? "motion-safe:animate-backdrop-fade-out"
            : "motion-safe:animate-backdrop-blur-in",
        )}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className={cn(
          "relative flex h-[var(--app-height,100dvh)] w-full max-w-2xl flex-col border-l border-border bg-background shadow-2xl",
          exiting
            ? "motion-safe:animate-sheet-out"
            : "motion-safe:animate-sheet-in",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border pl-5 pr-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            Post
          </span>
          <Button asChild variant="ghost" size="sm" className="h-8">
            <Link to="/posts/$id" params={{ id }}>
              <ExternalLink className="size-3.5" />
              Open page
            </Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close post"
            data-overlay-close
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-8">
            <PostDetail
              key={id}
              id={id}
              heading="h2"
              headingId={titleId}
              onDeleted={onClose}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
