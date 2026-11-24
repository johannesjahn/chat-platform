import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Copy,
  Forward,
  Link2,
  type LucideIcon,
  Pencil,
  Pin,
  PinOff,
  Reply,
  Star,
  Trash2,
} from "lucide-react";
import type { MessageActions } from "@/components/chat/bubble/MessageActionGroup";
import { Button } from "@/components/ui/button";
import { useTransitionState } from "@/lib/motion";
import { REACTION_EMOJIS, reactionOf } from "@/lib/reactions";
import { cn } from "@/lib/utils";

/**
 * A message's actions on touch (issue #906): what a long press opens, in
 * place of the hover pill's 24px unlabelled icons. A sheet at the foot of
 * the screen, the pattern most chat apps use — the reactions as a row of
 * big emoji, then every other action as a labelled row at least 44px tall.
 * It offers exactly what `MessageActionGroup` does, from the same props.
 * Choosing anything closes it first; a tap on the backdrop, or Escape,
 * closes it with nothing chosen.
 */
export function MessageActionSheet({
  open,
  onClose,
  preview,
  message,
  readOnly,
  reactionPending,
  onToggleReaction,
  pinPending,
  starPending,
  onTogglePin,
  onToggleStar,
  onCopy,
  onReply,
  onForward,
  onEdit,
  canDelete,
  deleting,
  onDelete,
}: MessageActions & {
  open: boolean;
  onClose: () => void;
  // The message's text, shown clamped at the top so it's clear which
  // message the sheet is for.
  preview: string | null;
}) {
  const { ref, phase, mounted } = useTransitionState<HTMLDivElement>(open);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  // The sheet opens under the finger that long-pressed, so the click a
  // browser may send when that finger lifts lands on the sheet. Only a click
  // whose press began inside it counts (or a keyboard one, `detail` 0) — a
  // leftover one must neither close it nor pick whatever row it hit.
  const pressedInside = useRef(false);

  // Focus moves into the sheet so a screen reader lands on it, and Escape
  // closes it. Captured on `window` and stopped there, like ConfirmDialog,
  // so nothing underneath reacts to the same key.
  useEffect(() => {
    if (!open) return;
    ref.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, ref]);

  if (!mounted) return null;
  const exiting = phase === "exiting";
  const choose = (action: () => void) => () => {
    onClose();
    action();
  };

  return createPortal(
    <div
      className="overlay-viewport z-50 flex items-end justify-center"
      inert={!open}
      onPointerDownCapture={() => {
        pressedInside.current = true;
      }}
      onClickCapture={(event) => {
        if (!pressedInside.current && event.detail !== 0) {
          event.preventDefault();
          event.stopPropagation();
        }
        pressedInside.current = false;
      }}
    >
      <div
        aria-hidden
        className={cn(
          "absolute inset-0 bg-background/70 backdrop-blur-sm",
          exiting
            ? "motion-safe:animate-backdrop-fade-out"
            : "motion-safe:animate-backdrop-blur-in",
        )}
        onClick={onClose}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Message actions"
        tabIndex={-1}
        className={cn(
          "relative flex max-h-full w-full max-w-md flex-col overflow-y-auto rounded-t-3xl border border-b-0 border-border bg-card px-3 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-2xl outline-none",
          exiting
            ? "motion-safe:animate-bottom-sheet-out"
            : "motion-safe:animate-bottom-sheet-in",
        )}
      >
        <span
          aria-hidden
          className="mx-auto mb-2 h-1 w-10 shrink-0 rounded-full bg-border"
        />
        {preview && (
          <p className="mb-2 line-clamp-2 break-words px-3 text-sm text-muted-foreground">
            {preview}
          </p>
        )}
        {!readOnly && (
          <div
            role="group"
            aria-label="React"
            className="mb-1 flex justify-between gap-1 border-b border-border/60 px-1 pb-2"
          >
            {REACTION_EMOJIS.map((emoji) => {
              const mine = reactionOf(message.reactions, emoji).reactedByMe;
              return (
                <button
                  key={emoji}
                  type="button"
                  disabled={reactionPending}
                  aria-label={`React with ${emoji}`}
                  aria-pressed={mine}
                  onClick={choose(() => onToggleReaction(emoji))}
                  className={cn(
                    "flex size-11 items-center justify-center rounded-full text-2xl transition-colors hover:bg-muted disabled:opacity-50",
                    mine && "bg-primary/15",
                  )}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        )}
        {onReply && !readOnly && (
          <SheetAction icon={Reply} label="Reply" onSelect={choose(onReply)} />
        )}
        {onForward && (
          <SheetAction
            icon={Forward}
            label="Forward"
            onSelect={choose(onForward)}
          />
        )}
        {message.body !== "" && (
          <SheetAction
            icon={Copy}
            label="Copy text"
            onSelect={choose(() => onCopy("text"))}
          />
        )}
        <SheetAction
          icon={Link2}
          label="Copy link"
          onSelect={choose(() => onCopy("link"))}
        />
        {!readOnly && (
          <SheetAction
            icon={message.pinned ? PinOff : Pin}
            label={message.pinned ? "Unpin message" : "Pin message"}
            disabled={pinPending}
            onSelect={choose(onTogglePin)}
          />
        )}
        <SheetAction
          icon={Star}
          label={message.starred ? "Unstar message" : "Star message"}
          disabled={starPending}
          onSelect={choose(onToggleStar)}
        />
        {onEdit && (
          <SheetAction
            icon={Pencil}
            label="Edit message"
            onSelect={choose(onEdit)}
          />
        )}
        {canDelete && (
          <SheetAction
            icon={Trash2}
            label="Delete message"
            disabled={deleting}
            onSelect={choose(onDelete)}
            className="text-destructive hover:text-destructive"
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

function SheetAction({
  icon: Icon,
  label,
  onSelect,
  disabled,
  className,
}: {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "h-12 w-full shrink-0 justify-start gap-3 rounded-xl px-3 text-base font-normal",
        className,
      )}
    >
      <Icon className="size-5" />
      {label}
    </Button>
  );
}
