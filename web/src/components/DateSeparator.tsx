import { formatDaySeparator } from "@/lib/chats";

// A centered day boundary inserted between messages whenever the local
// calendar day changes (issue #307). It's `sticky` to the top of the chat
// scroll area, so the day the currently-visible messages belong to stays
// pinned while scrolling — the polish most mature chat apps have. The pill
// itself carries a subtle fade/slide-in matching the message-in animation,
// gated behind `motion-safe` so it's skipped under `prefers-reduced-motion`.
export function DateSeparator({ ms }: { ms: number }) {
  return (
    // The wrapper is the sticky element and ignores pointer events so it never
    // intercepts clicks on messages scrolling beneath it; the pill re-enables
    // them for itself (it's non-interactive, but this keeps text selectable).
    <div
      data-testid="date-separator"
      className="pointer-events-none sticky top-0 z-10 flex justify-center py-1"
    >
      <span className="pointer-events-auto rounded-full border border-border bg-card/80 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-500">
        {formatDaySeparator(ms)}
      </span>
    </div>
  );
}
