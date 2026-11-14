import { Link } from "@tanstack/react-router";
import { Forward } from "lucide-react";
import { ProfileHoverCard } from "@/components/ProfileHoverCard";
import { parentPreviewText, type ChatMessage } from "@/lib/chats";
import { cn } from "@/lib/utils";

// Quoted parent (issue #217) — the message this one replies to, shown as a
// compact snippet above the body. A left accent bar and muted background
// set it apart from the reply's own content; it's tinted to sit on
// whichever bubble background it's on (own vs incoming). Null once the
// quoted message has been deleted server-side (the FK is set-null), so it
// simply doesn't render.
//
// With `onJumpToParent` wired up the whole snippet is a button that scrolls
// the thread back to the message being quoted; without it (no thread to
// scroll) it stays a plain, non-interactive block.
export function QuotedParent({
  parent,
  isOwn,
  onJumpToParent,
}: {
  parent: ChatMessage["parentMessage"];
  isOwn: boolean;
  onJumpToParent?: () => void;
}) {
  if (!parent) return null;
  const quoteClassName = cn(
    "mb-0.5 flex flex-col gap-0.5 rounded-md border-l-2 py-1 pl-2 pr-2 text-xs",
    isOwn
      ? "border-primary-foreground/50 bg-primary-foreground/10"
      : "border-primary/50 bg-muted",
  );
  const quoteBody = (
    <>
      <span
        className={cn(
          "flex items-center gap-1 font-semibold",
          isOwn ? "text-primary-foreground/90" : "text-primary",
        )}
      >
        {parent.forwarded && (
          <Forward className="size-3 shrink-0" aria-label="Forwarded" />
        )}
        {parent.senderName}
      </span>
      <span
        className={cn(
          "line-clamp-2 break-words",
          isOwn ? "text-primary-foreground/80" : "text-muted-foreground",
        )}
      >
        {parentPreviewText(parent)}
      </span>
    </>
  );
  return onJumpToParent ? (
    <button
      type="button"
      onClick={onJumpToParent}
      aria-label={`Go to the message from ${parent.senderName} this replies to`}
      className={cn(
        quoteClassName,
        "cursor-pointer text-left transition-colors",
        isOwn
          ? "hover:bg-primary-foreground/20"
          : "hover:bg-muted-foreground/15",
      )}
    >
      {quoteBody}
    </button>
  ) : (
    <div className={quoteClassName}>{quoteBody}</div>
  );
}

// "Forwarded from X" (issue #601) — the original sender's name as it was
// when the message was forwarded, so it still reads right after they
// rename, leave, or delete their account. It only links to a profile
// while that account exists (`senderId` goes null once it's deleted).
export function ForwardedLabel({
  forwardedFrom,
  isOwn,
}: {
  forwardedFrom: ChatMessage["forwardedFrom"];
  isOwn: boolean;
}) {
  if (!forwardedFrom) return null;
  return (
    <span
      data-testid="forwarded-label"
      className={cn(
        "flex items-center gap-1 text-xs italic",
        isOwn ? "text-primary-foreground/75" : "text-muted-foreground",
      )}
    >
      <Forward className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        Forwarded from{" "}
        {forwardedFrom.senderId !== null ? (
          <ProfileHoverCard userId={forwardedFrom.senderId}>
            <Link
              to="/users/$id"
              params={{ id: String(forwardedFrom.senderId) }}
              className="font-medium not-italic hover:underline"
            >
              {forwardedFrom.senderName}
            </Link>
          </ProfileHoverCard>
        ) : (
          <span className="font-medium not-italic">
            {forwardedFrom.senderName}
          </span>
        )}
      </span>
    </span>
  );
}
