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
  Trash2,
  X,
} from "lucide-react";
import { AttachmentPreview } from "@/components/AttachmentPreview";
import { ReactionPicker } from "@/components/CommentsSection";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { $api } from "@/lib/api";
import { attachmentKind } from "@/lib/attachments";
import {
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
  isRead: boolean;
  canModify: boolean;
  // Lets a chat's owner/admin (or a site-wide admin) delete someone else's
  // message for moderation — distinct from `canModify`, which only ever
  // applies to the sender's own messages and also allows editing (issue
  // #220 extended deletion, but not editing, to chat owners/admins).
  canDeleteOthers?: boolean;
  onEdit: (content: string) => Promise<void>;
  onDelete: () => Promise<void>;
  style?: CSSProperties;
};

export function MessageBubble({
  message,
  isOwn,
  senderLabel,
  isRead,
  canModify,
  canDeleteOthers = false,
  onEdit,
  onDelete,
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
      {isOwn && canModify && !isEditing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 translate-x-2 scale-95 transition-all duration-300 ease-smooth group-hover:opacity-100 group-hover:translate-x-0 group-hover:scale-100">
          {message.contentType === "text" && (
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

        {!isEditing && (
          <div
            className={cn(
              "transition-opacity duration-200",
              message.reactions.some((r) => r.count > 0)
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100",
            )}
          >
            <ReactionPicker
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
      </div>

      {!isOwn && canDeleteOthers && !isEditing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 translate-x-2 scale-95 transition-all duration-300 ease-smooth group-hover:opacity-100 group-hover:translate-x-0 group-hover:scale-100">
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
        </div>
      )}
    </div>
  );
}
