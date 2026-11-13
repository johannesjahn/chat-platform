import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SmilePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTransitionState } from "@/lib/motion";
import {
  REACTION_EMOJIS,
  reactionOf,
  type ReactionSummary,
} from "@/lib/reactions";
import { cn } from "@/lib/utils";

// Emoji reactions on posts, comments and messages. Apart from
// CommentsSection.tsx (issue #754): a post card shows its reactions from the
// first paint, but its comment thread — and the mention-aware composer that
// comes with it — only once it's opened, so that's a lazy chunk.

// The row of reaction pills — one per emoji that has at least one reaction
// (highlighted if the current user is one of them). Renders nothing when
// there are no active reactions, so a caller can render it unconditionally
// without reserving empty layout space for it (the chat's MessageBubble
// relies on this to keep the gap below a bubble only when a reaction is
// actually present).
export function ReactionList({
  reactions,
  pending,
  onToggle,
}: {
  reactions: ReadonlyArray<ReactionSummary>;
  pending: boolean;
  onToggle: (emoji: string) => void;
}) {
  const active = reactions.filter((r) => r.count > 0);
  if (active.length === 0) return null;
  return (
    <>
      {active.map((reaction) => (
        <Button
          // Keyed on whether it's yours as well as on the emoji, so toggling
          // a reaction remounts the pill and its entrance animations run
          // again — CSS only replays an animation whose element (or class) is
          // genuinely new.
          key={`${reaction.emoji}:${reaction.reactedByMe}`}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onToggle(reaction.emoji)}
          disabled={pending}
          aria-pressed={reaction.reactedByMe}
          aria-label={`${reaction.reactedByMe ? "Remove" : "Add"} ${reaction.emoji} reaction`}
          className={cn(
            "h-8 gap-1 rounded-full px-2 text-muted-foreground",
            reaction.reactedByMe &&
              "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
            // A ring thrown off the pill the instant the reaction becomes
            // yours. It's an `::after` on the pill rather than an element, so
            // it can't disturb the row's layout, and the `key` above is what
            // replays it: React remounts the button when `reactedByMe` flips,
            // which restarts both this and the emoji's kick.
            reaction.reactedByMe &&
              "motion-safe:after:absolute motion-safe:after:inset-0 motion-safe:after:rounded-full motion-safe:after:border motion-safe:after:border-primary/60 motion-safe:after:content-[''] motion-safe:after:pointer-events-none motion-safe:after:animate-reaction-burst",
          )}
        >
          <span
            className={cn(
              reaction.reactedByMe && "motion-safe:animate-emoji-pop",
            )}
          >
            {reaction.emoji}
          </span>
          <span className="tabular-nums">{reaction.count}</span>
        </Button>
      ))}
    </>
  );
}

// The "add a reaction" trigger and the popover of the standard emoji set it
// opens. Split out from `ReactionPicker` so it can be placed on its own —
// the chat's MessageBubble renders it beside the bubble, in the hover-only
// action group next to edit/delete, rather than below the message.
//
// The popover is rendered through a portal into `document.body`, positioned
// from the trigger button's own `getBoundingClientRect()`, rather than as a
// normal absolutely-positioned child — several call sites (PostCard, and
// CommentsSection itself) live inside a `Card` with `overflow-hidden` (for
// its image/decorative clipping), which would otherwise clip the popover
// invisible whenever the trigger sits near the bottom of the card.
export function ReactionAddButton({
  reactions,
  pending,
  onToggle,
  className,
  iconClassName,
}: {
  reactions: ReadonlyArray<ReactionSummary>;
  pending: boolean;
  onToggle: (emoji: string) => void;
  className?: string;
  iconClassName?: string;
}) {
  const [pickerPos, setPickerPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  // A wrapping span rather than a ref on `Button` itself — `Button` (see
  // components/ui/button.tsx) is a plain function component that doesn't
  // declare/forward a `ref` parameter, so it wouldn't receive one.
  const triggerRef = useRef<HTMLSpanElement>(null);
  const {
    ref: popoverRef,
    mounted: popoverMounted,
    phase: popoverPhase,
  } = useTransitionState<HTMLDivElement>(pickerPos !== null);
  // Where the picker last opened, so it can shrink away in place once
  // `pickerPos` has already been cleared.
  const [shownPos, setShownPos] = useState(pickerPos);
  if (pickerPos && pickerPos !== shownPos) setShownPos(pickerPos);

  useEffect(() => {
    if (!pickerPos) return;
    const close = (event: Event) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setPickerPos(null);
      }
    };
    // Closed on any scroll (capture phase catches scrolling within a nested
    // container, not just the window) rather than tracked/repositioned —
    // this popover is short-lived and simple, so it's not worth wiring up
    // continuous position updates.
    document.addEventListener("pointerdown", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [pickerPos, popoverRef]);

  return (
    <>
      <span ref={triggerRef} className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            if (pickerPos) {
              setPickerPos(null);
              return;
            }
            const rect = triggerRef.current?.getBoundingClientRect();
            if (rect) setPickerPos({ top: rect.bottom + 4, left: rect.left });
          }}
          disabled={pending}
          aria-expanded={pickerPos !== null}
          aria-label="Add a reaction"
          className={cn("h-8 gap-1.5 px-2 text-muted-foreground", className)}
        >
          <SmilePlus className={cn("size-4", iconClassName)} />
        </Button>
      </span>
      {popoverMounted &&
        shownPos &&
        createPortal(
          <div
            ref={popoverRef}
            style={{ top: shownPos.top, left: shownPos.left }}
            inert={pickerPos === null}
            className={cn(
              "fixed z-50 flex origin-top-left gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md",
              popoverPhase === "exiting"
                ? "motion-safe:animate-pop-close"
                : "motion-safe:animate-pop-open",
            )}
          >
            {REACTION_EMOJIS.map((emoji, i) => (
              <button
                key={emoji}
                type="button"
                disabled={pending}
                aria-label={`React with ${emoji}`}
                // The emoji cascade in left to right behind the popover's own
                // spring — `stagger-in` turns the index into the delay, the
                // same cadence the feed and the chat list step at.
                style={{ "--stagger-index": i } as CSSProperties}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md text-lg transition-transform duration-200 ease-spring hover:scale-125 hover:bg-muted motion-safe:animate-pop-open motion-safe:stagger-in",
                  reactionOf(reactions, emoji).reactedByMe && "bg-primary/10",
                )}
                onClick={() => {
                  onToggle(emoji);
                  setPickerPos(null);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

// The emoji reaction picker shared by posts and comments (issue #215,
// widened from the original binary "like" of issue #67): the row of active
// reaction pills followed by the "add a reaction" trigger. Kept generic over
// the caller's `onToggle` (post vs comment mutations) so both look and behave
// identically. The chat's MessageBubble composes `ReactionList` and
// `ReactionAddButton` separately instead of using this combined layout.
export function ReactionPicker({
  reactions,
  pending,
  onToggle,
}: {
  reactions: ReadonlyArray<ReactionSummary>;
  pending: boolean;
  onToggle: (emoji: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <ReactionList
        reactions={reactions}
        pending={pending}
        onToggle={onToggle}
      />
      <ReactionAddButton
        reactions={reactions}
        pending={pending}
        onToggle={onToggle}
      />
    </div>
  );
}
