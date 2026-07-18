import { AlertCircle, Clock, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { QueuedPost } from "@/lib/offlineQueue";
import { cn } from "@/lib/utils";

type PendingPostCardProps = {
  item: QueuedPost;
  onRetry: () => void;
  onDismiss: () => void;
};

// Feed-card equivalent of PendingMessageBubble — a post created while
// offline, queued locally (see lib/offlineQueue.ts) and not yet confirmed
// by the server. Shown above the real feed until it's replayed, at which
// point it's removed here and appears for real once the feed refetches.
export function PendingPostCard({
  item,
  onRetry,
  onDismiss,
}: PendingPostCardProps) {
  const failed = item.status === "failed";

  return (
    <Card
      role="article"
      aria-label="Pending post"
      data-testid="pending-post"
      data-status={item.status}
      className="w-full max-w-xl overflow-hidden py-0 opacity-80"
    >
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border py-3">
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs font-medium",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {failed ? (
            <>
              <AlertCircle className="size-3.5" />
              Failed to send
            </>
          ) : (
            <>
              <Clock className="size-3.5" />
              Pending sync — will send once you&apos;re back online
            </>
          )}
        </span>
        <div className="flex items-center gap-1">
          {failed && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Retry sending post"
              onClick={onRetry}
            >
              <RotateCw className="size-3.5" />
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Discard post"
            onClick={onDismiss}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-6 py-6">
        {item.contentType === "image_url" ? (
          <img
            src={item.content}
            alt=""
            loading="lazy"
            className="aspect-4/5 w-full rounded-md bg-muted object-cover"
          />
        ) : (
          <p className="whitespace-pre-wrap break-words text-base leading-relaxed">
            {item.content}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
