import { useQueryClient } from "@tanstack/react-query";
import type { usePendingMessages } from "@/components/chat/pendingMessages";
import { PendingMessageBubble } from "@/components/PendingMessageBubble";
import {
  dismissQueuedItem,
  replayQueue,
  retryQueuedItem,
} from "@/lib/offlineQueue";
import { dismissOutboxMessage, retryOutboxMessage } from "@/lib/outbox";

// The "sending"/"failed" bubbles below the thread, with Retry and Discard.
export function PendingMessageList({
  items,
}: {
  items: ReturnType<typeof usePendingMessages>;
}) {
  const queryClient = useQueryClient();
  return items.map((item) => (
    <PendingMessageBubble
      key={item.clientId}
      status={item.status}
      contentType={item.contentType}
      content={item.content}
      attachment={item.source === "outbox" ? item.attachment : undefined}
      caption={item.source === "outbox" ? item.caption : undefined}
      replyPreview={item.source === "outbox" ? item.replyPreview : undefined}
      createdAt={item.createdAt}
      error={item.error}
      onRetry={() => {
        if (item.source === "outbox") {
          retryOutboxMessage(item.clientId);
        } else {
          retryQueuedItem(item.clientId);
          void replayQueue(queryClient);
        }
      }}
      onDismiss={() =>
        item.source === "outbox"
          ? dismissOutboxMessage(item.clientId)
          : dismissQueuedItem(item.clientId)
      }
    />
  ));
}
