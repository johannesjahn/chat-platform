import {
  type CSSProperties,
  type TouchEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Check,
  CheckCheck,
  Copy,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Reply,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { AttachmentPreview } from "@/components/AttachmentPreview";
import { Avatar, type AvatarVariants } from "@/components/Avatar";
import { ProfileHoverCard } from "@/components/ProfileHoverCard";
import { ReactionAddButton, ReactionList } from "@/components/CommentsSection";
import { Lightbox } from "@/components/Lightbox";
import { MentionText } from "@/components/MentionText";
import { MentionTextarea } from "@/components/MentionTextarea";
import { Button } from "@/components/ui/button";
import { DisclosureChevron } from "@/components/ui/collapse";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { $api } from "@/lib/api";
import { attachmentKind } from "@/lib/attachments";
import {
  chatPinnedQueryKey,
  chatStarredQueryKey,
  MAX_MESSAGE_CONTENT_LENGTH,
  MESSAGE_COLLAPSE_THRESHOLD,
  patchCachedMessage,
  type ChatMessage,
} from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { useExpandableText } from "@/lib/motion";
import { formatAbsoluteTime } from "@/lib/time";
import type { ReactionEmoji } from "@/lib/reactions";
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
  // A narrow thread (a desktop docked chat window, issue #554): the action
  // group floats over the bubble's top edge as a toolbar instead of sitting
  // beside it, where — even invisible — it took the width the bubble needs.
  compact?: boolean;
  style?: CSSProperties;
};

// One-line label for what a quoted parent message holds — its text (trimmed to
// a single line by the CSS below), or a stand-in for non-text content so a
// reply's quote reads "Photo"/"Attachment" rather than a raw URL/filename.
function parentPreviewText(parent: {
  contentType: "text" | "image_url" | "attachment";
  content: string;
}): string {
  if (parent.contentType === "image_url") return "📷 Photo";
  if (parent.contentType === "attachment") return "📎 Attachment";
  return parent.content;
}

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
  onJumpToParent,
  highlightKey,
  editRequestKey,
  onEditEnd,
  compact = false,
  style,
}: MessageBubbleProps) {
  const queryClient = useQueryClient();
  const addReaction = $api.useMutation(
    "post",
    "/chats/{id}/messages/{messageId}/reactions",
  );
  const removeReaction = $api.useMutation(
    "delete",
    "/chats/{id}/messages/{messageId}/reactions",
  );
  const reactionPending = addReaction.isPending || removeReaction.isPending;
  const [reactionError, setReactionError] = useState<string | null>(null);

  // Any participant may react, not just the sender — wired up unconditionally
  // rather than gated behind `canModify`. Mirrors PostCard/CommentItem's
  // `toggleReaction`: the mutation's own response is the authoritative
  // `reactions` array, patched straight into the cache rather than waiting on
  // the `reaction_changed` WS round trip, and a failure surfaces visibly
  // instead of silently doing nothing (issue #233).
  const toggleReaction = async (emoji: string) => {
    const mine = message.reactions.find((r) => r.emoji === emoji)?.reactedByMe;
    const mutation = mine ? removeReaction : addReaction;
    setReactionError(null);
    try {
      const result = await mutation.mutateAsync({
        params: {
          path: {
            id: String(message.chatId),
            messageId: String(message.id),
          },
        },
        body: { emoji: emoji as ReactionEmoji },
      });
      patchCachedMessage(queryClient, message.chatId, message.id, (m) => ({
        ...m,
        reactions: result.reactions,
      }));
    } catch (err) {
      setReactionError(errorMessage(err));
    }
  };

  const pinMessage = $api.useMutation("post", "/chats/{id}/pins");
  const unpinMessage = $api.useMutation(
    "delete",
    "/chats/{id}/pins/{messageId}",
  );
  const starMessage = $api.useMutation(
    "post",
    "/chats/{id}/messages/{messageId}/star",
  );
  const unstarMessage = $api.useMutation(
    "delete",
    "/chats/{id}/messages/{messageId}/star",
  );
  const pinPending = pinMessage.isPending || unpinMessage.isPending;
  const starPending = starMessage.isPending || unstarMessage.isPending;
  const [actionError, setActionError] = useState<string | null>(null);

  // Pinning is chat-wide: patch the flag straight from the mutation response
  // (the `message_pin_changed` WS event reconciles every other participant),
  // and invalidate the pinned panel so the message enters/leaves it. Unpin
  // takes the id in the path; pin takes it in the body — see src/Api.ts.
  const togglePin = async () => {
    setActionError(null);
    try {
      const result = message.pinned
        ? await unpinMessage.mutateAsync({
            params: {
              path: {
                id: String(message.chatId),
                messageId: String(message.id),
              },
            },
          })
        : await pinMessage.mutateAsync({
            params: { path: { id: String(message.chatId) } },
            body: { messageId: message.id },
          });
      patchCachedMessage(queryClient, message.chatId, message.id, (m) => ({
        ...m,
        pinned: result.pinned,
      }));
      void queryClient.invalidateQueries({
        queryKey: chatPinnedQueryKey(message.chatId),
      });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  // Starring is private — no realtime event, so only this client's cache
  // updates (from the mutation response), plus its own starred panel.
  const toggleStar = async () => {
    setActionError(null);
    try {
      const result = message.starred
        ? await unstarMessage.mutateAsync({
            params: {
              path: {
                id: String(message.chatId),
                messageId: String(message.id),
              },
            },
          })
        : await starMessage.mutateAsync({
            params: {
              path: {
                id: String(message.chatId),
                messageId: String(message.id),
              },
            },
          });
      patchCachedMessage(queryClient, message.chatId, message.id, (m) => ({
        ...m,
        starred: result.starred,
      }));
      void queryClient.invalidateQueries({
        queryKey: chatStarredQueryKey(message.chatId),
      });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const hasReactions = message.reactions.some((r) => r.count > 0);
  const wasEdited = message.updatedAt !== message.createdAt;
  const isLongText =
    message.contentType === "text" &&
    message.content.length > MESSAGE_COLLAPSE_THRESHOLD;
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
  const canEdit = canModify && message.contentType === "text";

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

  // "Copy text" (issue #554): the action group's way to copy a message
  // without having to select it, with a tick for a moment once it's done.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copyText() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
    } catch {
      setActionError("Couldn't copy to the clipboard.");
    }
  }

  // Touch equivalent of the desktop hover-reveal (issue #309). The per-message
  // action group (react/pin/star/reply/edit/delete) is otherwise only shown on
  // `group-hover`, which touch devices never produce — so on phones/tablets it
  // was completely unreachable. A long press on the bubble reveals the same
  // group, mirroring the long-press-to-react gesture of most mobile messaging
  // apps; desktop hover behaviour is left untouched.
  const [touchRevealed, setTouchRevealed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  // Set once the long press actually fires, so the follow-up `contextmenu`
  // event (which mobile browsers emit on a long press) can be suppressed
  // without also swallowing a genuine desktop right-click.
  const longPressFired = useRef(false);

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // Cancel any pending timer if the bubble unmounts mid-press.
  useEffect(() => clearLongPress, []);

  // While the touch-revealed group is showing, dismiss it when the next tap
  // lands outside this message row (the reaction popover itself portals to
  // document.body, so picking an emoji counts as "outside" and collapses the
  // group too — which is the desired outcome once a reaction is chosen).
  //
  // A desktop right-click reveals the same group (issue #554) and is put
  // away the same way, or with Escape.
  useEffect(() => {
    if (!touchRevealed) return;
    const dismiss = (event: Event) => {
      const target = event.target as Node;
      if (rowRef.current && !rowRef.current.contains(target)) {
        setTouchRevealed(false);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setTouchRevealed(false);
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [touchRevealed]);

  const handleTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    if (isEditing) return;
    const touch = e.touches[0];
    if (!touch) return;
    touchStart.current = { x: touch.clientX, y: touch.clientY };
    longPressFired.current = false;
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      longPressTimer.current = null;
      setTouchRevealed(true);
      // A short haptic cue on trigger where supported (unsupported on e.g.
      // iOS Safari, hence the capability check rather than optional-call).
      if (typeof navigator.vibrate === "function") navigator.vibrate(10);
    }, 450);
  };

  const handleTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    const start = touchStart.current;
    const touch = e.touches[0];
    if (!start || !touch) return;
    // A finger that travels more than a few pixels is a scroll, not a press —
    // cancel so the picker never pops up mid-scroll.
    if (
      Math.abs(touch.clientX - start.x) > 10 ||
      Math.abs(touch.clientY - start.y) > 10
    ) {
      clearLongPress();
    }
  };

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

  // Pin (chat-wide) and star (private) toggles — shown in both the own-message
  // and incoming-message hover action groups, so the JSX is shared here rather
  // than duplicated on each side.
  const pinStarButtons = (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={message.pinned ? "Unpin message" : "Pin message"}
        aria-pressed={message.pinned}
        disabled={pinPending}
        onClick={() => void togglePin()}
        className={cn("size-6", message.pinned && "text-primary")}
      >
        {message.pinned ? (
          <PinOff className="size-3.5" />
        ) : (
          <Pin className="size-3.5" />
        )}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={message.starred ? "Unstar message" : "Star message"}
        aria-pressed={message.starred}
        disabled={starPending}
        onClick={() => void toggleStar()}
        className={cn("size-6", message.starred && "text-amber-500")}
      >
        <Star className={cn("size-3.5", message.starred && "fill-current")} />
      </Button>
      {message.contentType === "text" && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={copied ? "Copied" : "Copy text"}
          onClick={() => void copyText()}
          className="size-6"
        >
          {copied ? (
            <Check className="size-3.5 text-primary" />
          ) : (
            <Copy className="size-3" />
          )}
        </Button>
      )}
    </>
  );

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
  const parent = message.parentMessage;
  const quoteClassName = cn(
    "mb-0.5 flex flex-col gap-0.5 rounded-md border-l-2 py-1 pl-2 pr-2 text-xs",
    isOwn
      ? "border-primary-foreground/50 bg-primary-foreground/10"
      : "border-primary/50 bg-muted",
  );
  const quoteBody = parent && (
    <>
      <span
        className={cn(
          "font-semibold",
          isOwn ? "text-primary-foreground/90" : "text-primary",
        )}
      >
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
  const quotedParent = !parent ? null : onJumpToParent ? (
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
        "group relative isolate flex w-full items-center gap-1.5 motion-safe:animate-bubble-in stagger-in",
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
        <div className={actionGroupClassName}>
          <ReactionAddButton
            reactions={message.reactions}
            pending={reactionPending}
            onToggle={(emoji) => void toggleReaction(emoji)}
            className="size-6 px-0"
            iconClassName="size-3.5"
          />
          {pinStarButtons}
          {onReply && (
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
          {canEdit && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Edit message"
              className="size-6"
              onClick={startEditing}
            >
              <Pencil className="size-3" />
            </Button>
          )}
          {canModify && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Delete message"
              disabled={deleting}
              onClick={() => void handleDelete()}
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
      )}

      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={clearLongPress}
        onTouchCancel={clearLongPress}
        onContextMenu={(e) => {
          // Suppress the browser's own long-press context menu on touch.
          if (longPressFired.current) {
            e.preventDefault();
            return;
          }
          // A desktop right-click opens the message's actions, the way the
          // long press does on touch (issue #554) — except on a link, a
          // picture or player, or over selected text, where the browser's
          // own menu (copy link, save image, copy) is what's wanted.
          if (isEditing) return;
          const target = e.target as Element;
          if (target.closest("a, img, video, audio, button")) return;
          if (window.getSelection()?.toString()) return;
          e.preventDefault();
          setTouchRevealed(true);
        }}
        className={cn(
          // On a wide desktop pane the bubble is capped in characters too,
          // so lines stay readable — the pane takes the width, not the text.
          "flex min-w-0 max-w-[75%] flex-col gap-1 lg:max-w-[min(75%,70ch)]",
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
                className="w-fit text-xs font-semibold text-primary hover:underline"
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

          {quotedParent}

          {isEditing ? (
            <div className="flex flex-col gap-1.5">
              <MentionTextarea
                autoFocus
                value={draft}
                onValueChange={setDraft}
                onKeyDown={(e) => {
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
          ) : message.contentType === "attachment" && message.attachment ? (
            <AttachmentPreview
              attachment={message.attachment}
              className={attachmentWidthClassName}
            />
          ) : (
            <>
              <p
                ref={textRef}
                className={cn(
                  "whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-relaxed",
                  clamped && "line-clamp-4",
                )}
              >
                <MentionText
                  text={message.content}
                  // The primary-tinted link colour is invisible on an own
                  // message's primary-filled bubble — underline it against
                  // the bubble's own foreground colour there instead.
                  className={
                    isOwn ? "text-primary-foreground underline" : undefined
                  }
                />
              </p>
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
                  className="size-3.5 motion-safe:animate-check-draw"
                />
              ) : (
                <Check key="sent" className="size-3.5" />
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
              pending={reactionPending}
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
        <div className={actionGroupClassName}>
          <ReactionAddButton
            reactions={message.reactions}
            pending={reactionPending}
            onToggle={(emoji) => void toggleReaction(emoji)}
            className="size-6 px-0"
            iconClassName="size-3.5"
          />
          {pinStarButtons}
          {onReply && (
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
          {canDeleteOthers && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Delete message"
              disabled={deleting}
              onClick={() => void handleDelete()}
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
