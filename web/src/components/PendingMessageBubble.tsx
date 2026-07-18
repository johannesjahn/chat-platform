import { AlertCircle, Clock, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QueuedMessage } from "@/lib/offlineQueue";
import { cn } from "@/lib/utils";

type PendingMessageBubbleProps = {
  item: QueuedMessage;
  onRetry: () => void;
  onDismiss: () => void;
};

// Renders a message that's been queued locally (see lib/offlineQueue.ts)
// but not yet confirmed by the server — either still waiting for
// connectivity ("pending") or rejected on a previous replay attempt
// ("failed"). Deliberately not a `MessageBubble`: that component expects a
// real, server-assigned `ChatMessage` (id, read receipts, edit/delete
// endpoints), none of which exist yet for a queued item.
export function PendingMessageBubble({
  item,
  onRetry,
  onDismiss,
}: PendingMessageBubbleProps) {
  const failed = item.status === "failed";

  return (
    <div
      data-testid="pending-message"
      data-status={item.status}
      className="flex w-full items-center justify-end gap-1 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-2 motion-safe:duration-300"
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

      <div
        className={cn(
          "flex max-w-[75%] flex-col gap-1 rounded-2xl rounded-br-sm px-3.5 py-2.5 shadow-sm",
          failed
            ? "border border-destructive/40 bg-destructive/10 text-destructive"
            : "bg-primary/60 text-primary-foreground",
        )}
      >
        {item.contentType === "image_url" ? (
          <img
            src={item.content}
            alt=""
            loading="lazy"
            className="max-h-72 w-full rounded-lg bg-muted object-cover"
          />
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {item.content}
          </p>
        )}
        <div className="flex items-center justify-end gap-1 text-[11px] opacity-80">
          {failed ? (
            <>
              <AlertCircle className="size-3.5" />
              Failed to send
            </>
          ) : (
            <>
              <Clock className="size-3.5" />
              Pending sync…
            </>
          )}
        </div>
      </div>
    </div>
  );
}
