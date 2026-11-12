import type { CSSProperties } from "react";
import { AlertCircle, Clock, RotateCw, X } from "lucide-react";
import { AttachmentPreview } from "@/components/AttachmentPreview";
import { MentionText } from "@/components/MentionText";
import { Button } from "@/components/ui/button";
import { type Attachment, attachmentKind } from "@/lib/attachments";
import {
  MESSAGE_COLLAPSE_THRESHOLD,
  type MessageContentType,
  parentPreviewText,
} from "@/lib/chats";
import type { OutboxReplyPreview } from "@/lib/outbox";
import { cn } from "@/lib/utils";

// - "sending": a live send that's on its way (lib/outbox.ts). Drawn as the
//   message it's about to be, with a clock where the "sent" tick will go, so
//   the swap to the real one is a tick appearing rather than a new bubble.
// - "pending": queued while offline (lib/offlineQueue.ts), until reconnect.
// - "failed": the server rejected it — Retry or Discard.
export type PendingMessageStatus = "sending" | "pending" | "failed";

type PendingMessageBubbleProps = {
  status: PendingMessageStatus;
  contentType: MessageContentType;
  content: string;
  attachment?: Attachment;
  // Text sent alongside the attachment (issue #765), shown under it.
  caption?: string;
  replyPreview?: OutboxReplyPreview;
  createdAt: number;
  error?: string;
  onRetry: () => void;
  onDismiss: () => void;
};

function PendingText({ text, failed }: { text: string; failed: boolean }) {
  return (
    <p
      className={cn(
        "whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-relaxed",
        text.length > MESSAGE_COLLAPSE_THRESHOLD && "line-clamp-4",
      )}
    >
      <MentionText
        text={text}
        className={failed ? undefined : "text-primary-foreground underline"}
      />
    </p>
  );
}

// Renders a message the server hasn't confirmed yet. Deliberately not a
// `MessageBubble`: that component expects a real, server-assigned
// `ChatMessage` (id, read receipts, edit/delete endpoints), none of which
// exist yet. Its frame mirrors an own `MessageBubble`'s, so a "sending"
// bubble turning into the real message doesn't shift the thread.
export function PendingMessageBubble({
  status,
  contentType,
  content,
  attachment,
  caption,
  replyPreview,
  createdAt,
  error,
  onRetry,
  onDismiss,
}: PendingMessageBubbleProps) {
  const failed = status === "failed";

  return (
    <div
      data-testid="pending-message"
      data-status={status}
      style={{ "--bubble-from-x": "1.25rem" } as CSSProperties}
      className="flex w-full origin-bottom-right items-center justify-end gap-1.5 motion-safe:animate-bubble-in"
    >
      {failed && (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Retry sending message"
            className="size-6"
            onClick={onRetry}
          >
            <RotateCw className="size-3" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Discard message"
            className="size-6 text-destructive hover:text-destructive"
            onClick={onDismiss}
          >
            <X className="size-3" />
          </Button>
        </div>
      )}

      <div className="flex w-fit min-w-0 max-w-[75%] flex-col items-end gap-1 lg:max-w-[min(75%,70ch)]">
        <div
          title={failed ? error : undefined}
          className={cn(
            "flex flex-col gap-1 rounded-2xl rounded-br-sm px-3.5 py-2.5 shadow-sm",
            failed
              ? "border border-destructive/40 bg-destructive/10 text-destructive"
              : status === "pending"
                ? "bg-primary/60 text-primary-foreground"
                : "bg-primary text-primary-foreground",
          )}
        >
          {replyPreview && (
            <div
              className={cn(
                "mb-0.5 flex flex-col gap-0.5 rounded-md border-l-2 py-1 pl-2 pr-2 text-xs",
                failed
                  ? "border-destructive/50 bg-destructive/10"
                  : "border-primary-foreground/50 bg-primary-foreground/10",
              )}
            >
              <span className="font-semibold opacity-90">
                {replyPreview.senderName}
              </span>
              <span className="line-clamp-2 break-words opacity-80">
                {parentPreviewText(replyPreview)}
              </span>
            </div>
          )}

          {contentType === "image_url" ? (
            <img
              src={content}
              alt=""
              loading="lazy"
              className="max-h-72 w-72 max-w-full rounded-lg bg-muted object-cover"
            />
          ) : (
            <>
              {contentType === "attachment" && attachment && (
                <AttachmentPreview
                  attachment={attachment}
                  className={
                    ["image", "video", "audio"].includes(
                      attachmentKind(attachment.mimeType),
                    )
                      ? "w-72 max-w-full"
                      : undefined
                  }
                />
              )}
              {(contentType !== "attachment" || caption) && (
                // Clamped like a long `MessageBubble` text, so the real
                // message doesn't snap shorter when it takes over.
                <PendingText
                  text={contentType === "attachment" ? caption! : content}
                  failed={failed}
                />
              )}
            </>
          )}

          <div
            className={cn(
              "flex items-center justify-end gap-1 text-[11px]",
              failed ? "opacity-80" : "text-primary-foreground/70",
            )}
          >
            {failed ? (
              <>
                <AlertCircle className="size-3.5" />
                Failed to send
              </>
            ) : status === "pending" ? (
              <>
                <Clock className="size-3.5" />
                Pending sync…
              </>
            ) : (
              <>
                <span>
                  {new Date(createdAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
                <Clock role="img" aria-label="Sending" className="size-3.5" />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
