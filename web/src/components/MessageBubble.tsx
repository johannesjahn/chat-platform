import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, CheckCheck, Loader2, Pin, Star, X } from "lucide-react";
import { AttachmentPreview } from "@/components/AttachmentPreview";
import { Avatar, type AvatarVariants } from "@/components/Avatar";
import { ProfileHoverCard } from "@/components/ProfileHoverCard";
import { MessageActionGroup } from "@/components/chat/bubble/MessageActionGroup";
import {
  ForwardedLabel,
  QuotedParent,
} from "@/components/chat/bubble/MessageQuote";
import { useBubbleReveal } from "@/components/chat/bubble/useBubbleReveal";
import { useMessageToggles } from "@/components/chat/bubble/useMessageToggles";
import { ReactionList } from "@/components/ReactionPicker";
import { Lightbox } from "@/components/LazyLightbox";
import { MentionText } from "@/components/MentionText";
import { MentionTextarea } from "@/components/MentionTextarea";
import { Button } from "@/components/ui/button";
import { DisclosureChevron } from "@/components/ui/collapse";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { attachmentKind } from "@/lib/attachments";
import {
  MAX_MESSAGE_CONTENT_LENGTH,
  MESSAGE_COLLAPSE_THRESHOLD,
  type ChatMessage,
} from "@/lib/chats";
import { isImeComposing } from "@/lib/ime";
import { useExpandableText } from "@/lib/motion";
import { formatAbsoluteTime } from "@/lib/time";
import { cn } from "@/lib/utils";

type MessageBubbleProps = {
  message: ChatMessage;
  isOwn: boolean;
  senderLabel?: string;
  // The sender's `@username`, shown after `senderLabel` when that's a
  // display name (see `userHandle` in lib/users.ts).
  senderHandle?: string;
  // The sender's avatar, shown beside an incoming message in a group chat so
  // it's easy to tell at a glance who sent it. Only provided for other
  // people's messages in a group; direct chats and your own messages don't
  // get one.
  senderAvatar?: {
    name: string;
    avatarUrl?: string | null;
    avatarVariants?: AvatarVariants | null;
  };
  isRead: boolean;
  canModify: boolean;
  // Lets a chat's owner/admin (or a site-wide admin) delete someone else's
  // message for moderation — distinct from `canModify`, which only ever
  // applies to the sender's own messages and also allows editing (issue
  // #220 extended deletion, but not editing, to chat owners/admins).
  canDeleteOthers?: boolean;
  onEdit: (content: string) => Promise<void>;
  onDelete: () => Promise<void>;
  // Start composing a reply that quotes this message (issue #217). Omitted
  // where replying isn't offered (e.g. a message that's mid-edit).
  onReply?: () => void;
  // Open the picker to forward this message to other chats (issue #601).
  // Only ever wired up for a stored message — pending/queued sends render as
  // PendingMessageBubble, which has no actions at all.
  onForward?: () => void;
  // Jump the thread to the message this one is replying to. Only meaningful
  // when `message.parentMessage` is set — when provided, the quoted snippet
  // above the body becomes a button that scrolls to (and highlights) the
  // message being answered, the usual messaging-app gesture for "what was
  // this replying to?". Omitted where there's nothing to scroll (e.g. the
  // quoted parent rendered outside the thread).
  onJumpToParent?: () => void;
  // Set while this message is the one the thread just jumped to (a reply's
  // quote, a pinned row, a search result), and changed on every new jump to
  // it so the highlight replays. Rendered as its own overlay element rather
  // than a class toggled on the row from script: the row already runs
  // `animate-bubble-in` behind a `motion-safe:` variant, which out-ranks a
  // plain `animate-jump-flash` in the cascade and swallowed the pulse, and
  // any re-render of the row's `className` wiped a script-added class anyway.
  highlightKey?: number;
  // Changed to open this message's editor from outside the bubble — `↑` in
  // an empty composer edits your last message (issue #554). Ignored unless
  // the message is editable at all.
  editRequestKey?: number;
  // Called when an edit ends (saved or cancelled), so the composer can take
  // focus back.
  onEditEnd?: () => void;
  // A message request the viewer hasn't accepted yet (issue #785): they can
  // read it, but the server turns away anything others would see — a
  // reaction, a pin, a reply, an edit (issue #808) — so those aren't offered.
  // Private actions (star, copy, forward out) stay.
  readOnly?: boolean;
  // A narrow thread (a desktop docked chat window, issue #554, or any thread
  // below `lg`): the action group floats over the bubble's top edge as a
  // toolbar instead of sitting beside it, where — even invisible — it took
  // the width the bubble needs.
  compact?: boolean;
  // Off for a message that was already on screen as a "sending" or queued
  // bubble (see `wasShownBeforeConfirm` in lib/chats.ts): it's taking over
  // from that bubble, not arriving.
  animateIn?: boolean;
  style?: CSSProperties;
};

export function MessageBubble({
  message,
  isOwn,
  senderLabel,
  senderHandle,
  senderAvatar,
  isRead,
  canModify,
  canDeleteOthers = false,
  onEdit,
  onDelete,
  onReply,
  onForward,
  onJumpToParent,
  highlightKey,
  editRequestKey,
  onEditEnd,
  readOnly = false,
  compact = false,
  animateIn = true,
  style,
}: MessageBubbleProps) {
  const {
    reactionPending,
    reactionError,
    toggleReaction,
    pinPending,
    starPending,
    actionError,
    setActionError,
    togglePin,
    toggleStar,
  } = useMessageToggles(message);

  const hasReactions = message.reactions.some((r) => r.count > 0);
  const wasEdited = message.updatedAt !== message.createdAt;
  // The prose the bubble shows: a text message's content, or an attachment's
  // caption (issue #765), under the file. An attachment whose file is gone
  // still shows its filename, as it always has.
  const hasAttachment =
    message.contentType === "attachment" && message.attachment !== null;
  const bodyText =
    message.contentType === "image_url"
      ? null
      : message.contentType === "attachment"
        ? (message.caption ?? (hasAttachment ? null : message.content))
        : message.content;
  const isLongText = (bodyText?.length ?? 0) > MESSAGE_COLLAPSE_THRESHOLD;
  const {
    ref: textRef,
    expanded,
    clamped,
    toggle: toggleExpanded,
  } = useExpandableText<HTMLParagraphElement>(!isLongText, "line-clamp-4");
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirm = useConfirm();
  const canEdit = canModify && !readOnly && message.contentType === "text";

  function startEditing() {
    setDraft(message.content);
    setIsEditing(true);
  }

  function stopEditing() {
    setIsEditing(false);
    onEditEnd?.();
  }

  // A new request opens the editor during render (the "adjust state when a
  // prop changes" pattern), so it's open on the very commit that asked.
  const [seenEditRequest, setSeenEditRequest] = useState(editRequestKey);
  if (editRequestKey !== seenEditRequest) {
    setSeenEditRequest(editRequestKey);
    if (editRequestKey !== undefined && canEdit) startEditing();
  }
  useEffect(() => {
    if (editRequestKey === undefined) return;
    rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [editRequestKey]);

  // "Copy text" (issue #554) and "Copy link" (issue #600): the action
  // group's ways to copy a message without having to select it, or to point
  // someone at it, with a tick for a moment once it's done. The link is the
  // same `?message=` deep link search results land on, so it opens the chat
  // scrolled to this message and highlighted.
  const [copied, setCopied] = useState<"text" | "link" | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy(kind: "text" | "link") {
    const value =
      kind === "text"
        ? (bodyText ?? message.content)
        : `${window.location.origin}/chats/${message.chatId}?message=${message.id}`;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      setActionError("Couldn't copy to the clipboard.");
    }
  }

  const [lightboxOpen, setLightboxOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const reveal = useBubbleReveal(rowRef, isEditing);
  const touchRevealed = reveal.revealed;

  const trimmedDraft = draft.trim();
  const canSave =
    trimmedDraft.length > 0 &&
    trimmedDraft.length <= MAX_MESSAGE_CONTENT_LENGTH &&
    trimmedDraft !== message.content;

  // Chat bubbles size to content (no definite width), so a percentage-width
  // media element can't resolve against it and collapses to its intrinsic
  // pixel size instead — give image/video/audio attachments a fixed,
  // reasonable width. File/PDF rows aren't affected by that bug and should
  // keep sizing to their content.
  const attachmentWidthClassName =
    message.contentType === "attachment" &&
    message.attachment &&
    ["image", "video", "audio"].includes(
      attachmentKind(message.attachment.mimeType),
    )
      ? "w-72 max-w-full"
      : undefined;

  async function handleSave() {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onEdit(trimmedDraft);
      stopEditing();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: "Delete this message?",
      description:
        "It's removed from the chat for everyone. This can't be undone.",
      confirmLabel: "Delete message",
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  }

  // Shared visibility classes for both action groups (own + incoming). Hidden
  // and revealed on `group-hover` for pointer devices as before; when a long
  // press has revealed it on touch, the visible state is applied outright.
  const actionGroupClassName = cn(
    "flex shrink-0 items-center gap-0.5 transition-all duration-300 ease-smooth",
    touchRevealed
      ? "opacity-100 translate-x-0 scale-100"
      : "opacity-0 translate-x-2 scale-95 group-hover:opacity-100 group-hover:translate-x-0 group-hover:scale-100",
    compact &&
      cn(
        "absolute -top-3.5 z-10 rounded-full border border-border bg-popover px-1 py-0.5 shadow-md",
        isOwn ? "right-1" : "left-1",
        // Invisible, it mustn't sit over the message above and eat clicks.
        !touchRevealed && "pointer-events-none group-hover:pointer-events-auto",
      ),
  );

  return (
    <div
      ref={rowRef}
      data-message-id={message.id}
      // `--bubble-from-x` is the side the row unfolds from: a message you
      // sent grows out of the right edge, one you received out of the left
      // (see `animate-bubble-in` in styles.css). The row keeps whatever
      // `style` its caller passed — the thread's stagger index — by merging
      // rather than replacing it.
      style={
        {
          ...style,
          "--bubble-from-x": isOwn ? "1.25rem" : "-1.25rem",
        } as CSSProperties
      }
      className={cn(
        // `relative isolate` gives the jump highlight below something to
        // position against and a stacking context to sit at the back of.
        "group relative isolate flex w-full items-center gap-1.5",
        animateIn && "motion-safe:animate-bubble-in stagger-in",
        // The origin pins the scale to the corner the bubble's tail is on, so
        // the row unfolds from that side instead of shrinking toward its own
        // centre and drifting sideways on the way in.
        isOwn
          ? "justify-end origin-bottom-right"
          : "justify-start origin-bottom-left",
      )}
    >
      {highlightKey != null && (
        // Keyed by the jump, so a repeat jump to the same message remounts it
        // and the pulse starts over. Behind the bubble (`-z-10`) so the tint
        // never washes over the text it's pointing at.
        <span
          key={highlightKey}
          aria-hidden
          data-testid="jump-highlight"
          className="pointer-events-none absolute -inset-x-2 -inset-y-1 -z-10 animate-jump-flash"
        />
      )}
      {!isOwn && senderAvatar && (
        <ProfileHoverCard userId={message.senderId}>
          <Link
            to="/users/$id"
            params={{ id: String(message.senderId) }}
            className="shrink-0 self-end"
            aria-label={senderLabel ? `${senderLabel}'s profile` : "Profile"}
          >
            <Avatar
              name={senderAvatar.name}
              avatarUrl={senderAvatar.avatarUrl}
              avatarVariants={senderAvatar.avatarVariants}
              size="sm"
            />
          </Link>
        </ProfileHoverCard>
      )}

      {isOwn && !isEditing && (
        <MessageActionGroup
          message={message}
          className={actionGroupClassName}
          readOnly={readOnly}
          reactionPending={reactionPending}
          onToggleReaction={(emoji) => void toggleReaction(emoji)}
          pinPending={pinPending}
          starPending={starPending}
          onTogglePin={() => void togglePin()}
          onToggleStar={() => void toggleStar()}
          copied={copied}
          onCopy={(kind) => void copy(kind)}
          onReply={onReply}
          onForward={onForward}
          deleting={deleting}
          onDelete={() => void handleDelete()}
          onEdit={canEdit ? startEditing : undefined}
          canDelete={canModify}
        />
      )}

      <div
        {...reveal.handlers}
        className={cn(
          // On a wide desktop pane the bubble is capped in characters too,
          // so lines stay readable — the pane takes the width, not the text.
          // `w-fit` gives the row a sane flex basis: left at `auto`, a long
          // unbroken word's max-content made the bubble soak up nearly all
          // of the row's shrinking and collapse to a sliver.
          "flex w-fit min-w-0 max-w-[75%] flex-col gap-1 lg:max-w-[min(75%,70ch)]",
          isOwn ? "items-end" : "items-start",
        )}
      >
        <div
          className={cn(
            "flex flex-col gap-1 rounded-2xl px-3.5 py-2.5 shadow-sm transition-transform duration-200",
            isOwn
              ? "rounded-br-sm bg-primary text-primary-foreground"
              : "rounded-bl-sm border border-border bg-card text-card-foreground",
          )}
        >
          {senderLabel && !isOwn && (
            <ProfileHoverCard userId={message.senderId}>
              <Link
                to="/users/$id"
                params={{ id: String(message.senderId) }}
                // Breaks a long name: as one unbreakable word it would set
                // the bubble's width and push it past the thread's edge.
                className="w-fit max-w-full text-xs font-semibold text-primary wrap-anywhere hover:underline"
              >
                {senderLabel}
                {senderHandle && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    {senderHandle}
                  </span>
                )}
              </Link>
            </ProfileHoverCard>
          )}

          <ForwardedLabel forwardedFrom={message.forwardedFrom} isOwn={isOwn} />

          <QuotedParent
            parent={message.parentMessage}
            isOwn={isOwn}
            onJumpToParent={onJumpToParent}
          />

          {isEditing ? (
            <div className="flex flex-col gap-1.5">
              <MentionTextarea
                autoFocus
                value={draft}
                onValueChange={setDraft}
                onKeyDown={(e) => {
                  if (isImeComposing(e)) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSave();
                  } else if (e.key === "Escape") {
                    // Handled: a docked window around this mustn't also
                    // close on the same key press.
                    e.preventDefault();
                    stopEditing();
                  }
                }}
                rows={1}
                className={cn(
                  "min-h-9 resize-none border-none bg-transparent p-0 text-sm leading-relaxed shadow-none focus-visible:ring-0",
                  isOwn && "text-primary-foreground",
                )}
              />
              <div className="flex items-center justify-end gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Cancel edit"
                  disabled={saving}
                  className={cn(
                    "size-6",
                    isOwn && "hover:bg-primary-foreground/20",
                  )}
                  onClick={stopEditing}
                >
                  <X className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Save edit"
                  disabled={!canSave || saving}
                  onClick={() => void handleSave()}
                  className={cn(
                    "size-6",
                    isOwn && "hover:bg-primary-foreground/20",
                  )}
                >
                  {saving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                </Button>
              </div>
            </div>
          ) : message.contentType === "image_url" ? (
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              onPointerEnter={Lightbox.preload}
              onFocus={Lightbox.preload}
              aria-label="View image full-size"
              className="block cursor-zoom-in"
            >
              <img
                src={message.content}
                alt=""
                loading="lazy"
                className="max-h-72 w-72 max-w-full rounded-lg bg-muted object-cover"
              />
            </button>
          ) : (
            <>
              {hasAttachment && message.attachment && (
                <AttachmentPreview
                  attachment={message.attachment}
                  className={attachmentWidthClassName}
                />
              )}
              {bodyText !== null && (
                <p
                  ref={textRef}
                  className={cn(
                    "whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-relaxed",
                    clamped && "line-clamp-4",
                  )}
                >
                  <MentionText
                    text={bodyText}
                    // The primary-tinted link colour is invisible on an own
                    // message's primary-filled bubble — underline it against
                    // the bubble's own foreground colour there instead.
                    className={
                      isOwn ? "text-primary-foreground underline" : undefined
                    }
                  />
                </p>
              )}
              {isLongText && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  aria-expanded={expanded}
                  onClick={toggleExpanded}
                  className={cn(
                    "h-auto self-start p-0 text-xs",
                    isOwn && "text-primary-foreground underline",
                  )}
                >
                  <DisclosureChevron open={expanded} className="size-3.5" />
                  {expanded ? "Show less" : "Show more"}
                </Button>
              )}
            </>
          )}

          <div
            className={cn(
              "flex items-center justify-end gap-1 text-[11px]",
              isOwn ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {/* Chat-wide pin badge (everyone sees it) and the viewer's own
                private star badge (issue #223). */}
            {message.pinned && (
              <Pin
                className="size-3 shrink-0 fill-current"
                aria-label="Pinned"
              />
            )}
            {message.starred && (
              <Star
                className="size-3 shrink-0 fill-current text-amber-500"
                aria-label="Starred"
              />
            )}
            <span title={formatAbsoluteTime(message.createdAt)}>
              {new Date(message.createdAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
              {wasEdited && " · edited"}
            </span>
            {isOwn &&
              (isRead ? (
                // Wipes in from the left the moment the second tick arrives,
                // so "they've read it" is something you see happen rather
                // than a glyph that was quietly swapped underneath you. Keyed
                // on the state so React remounts it and the animation
                // actually replays. See `animate-check-draw`.
                <CheckCheck
                  key="read"
                  role="img"
                  aria-label="Read"
                  className="size-3.5 motion-safe:animate-check-draw"
                />
              ) : (
                <Check
                  key="sent"
                  role="img"
                  aria-label="Sent"
                  className="size-3.5"
                />
              ))}
          </div>
        </div>

        {/* The reaction pills sit below the bubble, but only once there's an
            actual reaction to show — otherwise nothing renders here at all, so
            the parent's `gap-1` doesn't reserve empty space under every
            message. Adding a reaction is done from the button beside the bubble
            instead — revealed on hover for pointer devices, or via a long press
            on touch (issue #309); see the action groups on either side. */}
        {!isEditing && hasReactions && (
          <div className="flex flex-wrap items-center gap-1">
            <ReactionList
              reactions={message.reactions}
              pending={reactionPending || readOnly}
              onToggle={(emoji) => void toggleReaction(emoji)}
            />
          </div>
        )}
        {reactionError && (
          <p className="max-w-[240px] text-xs text-destructive">
            {reactionError}
          </p>
        )}
        {actionError && (
          <p className="max-w-[240px] text-xs text-destructive">
            {actionError}
          </p>
        )}
      </div>

      {!isOwn && !isEditing && (
        <MessageActionGroup
          message={message}
          className={actionGroupClassName}
          readOnly={readOnly}
          reactionPending={reactionPending}
          onToggleReaction={(emoji) => void toggleReaction(emoji)}
          pinPending={pinPending}
          starPending={starPending}
          onTogglePin={() => void togglePin()}
          onToggleStar={() => void toggleStar()}
          copied={copied}
          onCopy={(kind) => void copy(kind)}
          onReply={onReply}
          onForward={onForward}
          deleting={deleting}
          onDelete={() => void handleDelete()}
          canDelete={canDeleteOthers}
        />
      )}
      {lightboxOpen && message.contentType === "image_url" && (
        <Lightbox
          src={message.content}
          alt=""
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </div>
  );
}
