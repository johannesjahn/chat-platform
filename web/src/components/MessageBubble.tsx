import { type CSSProperties, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
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
import { ReactionAddButton, ReactionList } from "@/components/CommentsSection";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import type { ReactionEmoji } from "@/lib/reactions";
import { cn } from "@/lib/utils";

type MessageBubbleProps = {
  message: ChatMessage;
  isOwn: boolean;
  senderLabel?: string;
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
  senderAvatar,
  isRead,
  canModify,
  canDeleteOthers = false,
  onEdit,
  onDelete,
  onReply,
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
  const [expanded, setExpanded] = useState(!isLongText);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this message? This can't be undone.")) return;
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
    </>
  );

  return (
    <div
      data-message-id={message.id}
      style={style}
      className={cn(
        "group flex w-full items-center gap-1.5 motion-safe:fill-mode-both motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-500 ease-spring",
        isOwn
          ? "justify-end motion-safe:slide-in-from-right-4"
          : "justify-start motion-safe:slide-in-from-left-4",
      )}
    >
      {!isOwn && senderAvatar && (
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
      )}

      {isOwn && !isEditing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 translate-x-2 scale-95 transition-all duration-300 ease-smooth group-hover:opacity-100 group-hover:translate-x-0 group-hover:scale-100">
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
          {canModify && message.contentType === "text" && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Edit message"
              className="size-6"
              onClick={() => {
                setDraft(message.content);
                setIsEditing(true);
              }}
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
        className={cn(
          "flex max-w-[75%] flex-col gap-1",
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
            <Link
              to="/users/$id"
              params={{ id: String(message.senderId) }}
              className="w-fit text-xs font-semibold text-primary hover:underline"
            >
              {senderLabel}
            </Link>
          )}

          {/* Quoted parent (issue #217) — the message this one replies to,
              shown as a compact snippet above the body. A left accent bar and
              muted background set it apart from the reply's own content; it's
              tinted to sit on whichever bubble background it's on (own vs
              incoming). Null once the quoted message has been deleted
              server-side (the FK is set-null), so it simply doesn't render. */}
          {message.parentMessage && (
            <div
              className={cn(
                "mb-0.5 flex flex-col gap-0.5 rounded-md border-l-2 py-1 pl-2 pr-2 text-xs",
                isOwn
                  ? "border-primary-foreground/50 bg-primary-foreground/10"
                  : "border-primary/50 bg-muted",
              )}
            >
              <span
                className={cn(
                  "font-semibold",
                  isOwn ? "text-primary-foreground/90" : "text-primary",
                )}
              >
                {message.parentMessage.senderName}
              </span>
              <span
                className={cn(
                  "line-clamp-2 break-words",
                  isOwn
                    ? "text-primary-foreground/80"
                    : "text-muted-foreground",
                )}
              >
                {parentPreviewText(message.parentMessage)}
              </span>
            </div>
          )}

          {isEditing ? (
            <div className="flex flex-col gap-1.5">
              <Textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSave();
                  } else if (e.key === "Escape") {
                    setIsEditing(false);
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
                  onClick={() => setIsEditing(false)}
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
            <img
              src={message.content}
              alt=""
              loading="lazy"
              className="max-h-72 w-72 max-w-full rounded-lg bg-muted object-cover"
            />
          ) : message.contentType === "attachment" && message.attachment ? (
            <AttachmentPreview
              attachment={message.attachment}
              className={attachmentWidthClassName}
            />
          ) : (
            <>
              <p
                className={cn(
                  "whitespace-pre-wrap break-words text-sm leading-relaxed",
                  !expanded && "line-clamp-4",
                )}
              >
                {message.content}
              </p>
              {isLongText && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => setExpanded((prev) => !prev)}
                  className={cn(
                    "h-auto self-start p-0 text-xs",
                    isOwn && "text-primary-foreground underline",
                  )}
                >
                  {expanded ? (
                    <>
                      <ChevronUp className="size-3.5" />
                      Show less
                    </>
                  ) : (
                    <>
                      <ChevronDown className="size-3.5" />
                      Show more
                    </>
                  )}
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
            <span>
              {new Date(message.createdAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
              {wasEdited && " · edited"}
            </span>
            {isOwn &&
              (isRead ? (
                <CheckCheck className="size-3.5" />
              ) : (
                <Check className="size-3.5" />
              ))}
          </div>
        </div>

        {/* The reaction pills sit below the bubble, but only once there's an
            actual reaction to show — otherwise nothing renders here at all, so
            the parent's `gap-1` doesn't reserve empty space under every
            message. Adding a reaction is done from the hover-only button beside
            the bubble instead (see the action groups on either side). */}
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
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 translate-x-2 scale-95 transition-all duration-300 ease-smooth group-hover:opacity-100 group-hover:translate-x-0 group-hover:scale-100">
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
    </div>
  );
}
