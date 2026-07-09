import { type CSSProperties, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  MAX_MESSAGE_CONTENT_LENGTH,
  MESSAGE_COLLAPSE_THRESHOLD,
  type ChatMessage,
} from "@/lib/chats";

type MessageBubbleProps = {
  message: ChatMessage;
  isOwn: boolean;
  senderUsername?: string;
  isRead: boolean;
  canModify: boolean;
  onEdit: (content: string) => Promise<void>;
  onDelete: () => Promise<void>;
  style?: CSSProperties;
};

export function MessageBubble({
  message,
  isOwn,
  senderUsername,
  isRead,
  canModify,
  onEdit,
  onDelete,
  style,
}: MessageBubbleProps) {
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
        "group flex w-full items-center gap-1 motion-safe:fill-mode-both motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300",
        isOwn
          ? "justify-end motion-safe:slide-in-from-right-2"
          : "justify-start motion-safe:slide-in-from-left-2",
      )}
    >
      {isOwn && canModify && !isEditing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
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
          "flex max-w-[75%] flex-col gap-1 rounded-2xl px-3.5 py-2.5 shadow-sm transition-transform duration-200",
          isOwn
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm border border-border bg-card text-card-foreground",
        )}
      >
        {senderUsername && !isOwn && (
          <Link
            to="/users/$id"
            params={{ id: String(message.senderId) }}
            className="w-fit text-xs font-semibold text-primary hover:underline"
          >
            @{senderUsername}
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
            className="max-h-72 w-full rounded-lg bg-muted object-cover"
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
    </div>
  );
}
