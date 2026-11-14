import {
  Check,
  Copy,
  Forward,
  Link2,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Reply,
  Star,
  Trash2,
} from "lucide-react";
import { ReactionAddButton } from "@/components/ReactionPicker";
import { Button } from "@/components/ui/button";
import type { ChatMessage } from "@/lib/chats";
import { cn } from "@/lib/utils";

/**
 * The hover/long-press action group beside a bubble: react, pin, star, copy
 * text, copy link, reply, forward, then edit and delete. Own and incoming
 * messages get the same group (split out of MessageBubble in issue #811) —
 * they differ only in whether editing is offered (`onEdit`) and what allows
 * deleting (`canDelete`: the sender, or a chat owner/admin moderating).
 */
export function MessageActionGroup({
  message,
  className,
  readOnly,
  reactionPending,
  onToggleReaction,
  pinPending,
  starPending,
  onTogglePin,
  onToggleStar,
  copied,
  onCopy,
  onReply,
  onForward,
  onEdit,
  canDelete,
  deleting,
  onDelete,
}: {
  message: ChatMessage;
  className: string;
  readOnly: boolean;
  reactionPending: boolean;
  onToggleReaction: (emoji: string) => void;
  pinPending: boolean;
  starPending: boolean;
  onTogglePin: () => void;
  onToggleStar: () => void;
  copied: "text" | "link" | null;
  onCopy: (kind: "text" | "link") => void;
  onReply?: () => void;
  onForward?: () => void;
  onEdit?: () => void;
  canDelete: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  return (
    <div className={className}>
      {!readOnly && (
        <ReactionAddButton
          reactions={message.reactions}
          pending={reactionPending}
          onToggle={onToggleReaction}
          className="size-6 px-0"
          iconClassName="size-3.5"
        />
      )}
      {/* Pin (chat-wide) and star (private) toggles, and the ways to copy a
          message without having to select it. */}
      {!readOnly && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={message.pinned ? "Unpin message" : "Pin message"}
          aria-pressed={message.pinned}
          disabled={pinPending}
          onClick={onTogglePin}
          className={cn("size-6", message.pinned && "text-primary")}
        >
          {message.pinned ? (
            <PinOff className="size-3.5" />
          ) : (
            <Pin className="size-3.5" />
          )}
        </Button>
      )}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={message.starred ? "Unstar message" : "Star message"}
        aria-pressed={message.starred}
        disabled={starPending}
        onClick={onToggleStar}
        className={cn("size-6", message.starred && "text-amber-500")}
      >
        <Star className={cn("size-3.5", message.starred && "fill-current")} />
      </Button>
      {(message.contentType === "text" || message.caption) && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={copied === "text" ? "Copied" : "Copy text"}
          onClick={() => onCopy("text")}
          className="size-6"
        >
          {copied === "text" ? (
            <Check className="size-3.5 text-primary" />
          ) : (
            <Copy className="size-3" />
          )}
        </Button>
      )}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={copied === "link" ? "Link copied" : "Copy link"}
        onClick={() => onCopy("link")}
        className="size-6"
      >
        {copied === "link" ? (
          <Check className="size-3.5 text-primary" />
        ) : (
          <Link2 className="size-3.5" />
        )}
      </Button>
      {onReply && !readOnly && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Reply to message"
          className="size-6"
          onClick={onReply}
        >
          <Reply className="size-3.5" />
        </Button>
      )}
      {onForward && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Forward message"
          className="size-6"
          onClick={onForward}
        >
          <Forward className="size-3.5" />
        </Button>
      )}
      {onEdit && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Edit message"
          className="size-6"
          onClick={onEdit}
        >
          <Pencil className="size-3" />
        </Button>
      )}
      {canDelete && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Delete message"
          disabled={deleting}
          onClick={onDelete}
          className="size-6 text-destructive hover:text-destructive"
        >
          {deleting ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Trash2 className="size-3" />
          )}
        </Button>
      )}
    </div>
  );
}
