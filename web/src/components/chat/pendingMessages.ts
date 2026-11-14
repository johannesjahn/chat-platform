import { useMemo } from "react";
import { onlineManager } from "@tanstack/react-query";
import type { ReplyTarget } from "@/components/ChatComposer";
import type { Attachment } from "@/lib/attachments";
import type { ChatMessage } from "@/lib/chats";
import { enqueueMessage, useQueuedMessages } from "@/lib/offlineQueue";
import { sendViaOutbox, useOutboxMessages } from "@/lib/outbox";

// The composer's side of a conversation (see "Optimistic message sends" in
// CLAUDE.md), split out of ChatConversation in issue #811: where a send goes,
// and the bubbles shown for sends the server hasn't confirmed yet.

export type ComposerSend = {
  contentType: "text" | "image_url" | "attachment";
  content: string;
  attachmentId?: number;
  attachment?: Attachment;
  caption?: string;
  parentMessageId?: number;
};

// Fire-and-forget: the composer clears straight away either way.
export function sendFromComposer(
  chatId: number,
  values: ComposerSend,
  replyingTo: ReplyTarget | null,
) {
  // Offline: queue instead of attempting the request at all — it would
  // just fail (see lib/offlineQueue.ts, replayed once back online). An
  // attachment message can't be queued this way (ChatComposer only lets
  // one through while online, since it needs an already-completed
  // upload), so it always goes out live below.
  if (values.contentType !== "attachment" && !onlineManager.isOnline()) {
    enqueueMessage(chatId, {
      contentType: values.contentType,
      content: values.content,
      parentMessageId: values.parentMessageId,
    });
    return;
  }
  // Shown straight away as a "sending" bubble and sent in the background
  // (lib/outbox.ts). The server also pushes a `chat_updated` event to every
  // participant, the sender included, which reconciles what the response
  // can't carry (e.g. read receipts).
  sendViaOutbox(chatId, {
    ...values,
    replyPreview:
      replyingTo && replyingTo.id === values.parentMessageId
        ? {
            senderName: replyingTo.senderName,
            contentType: replyingTo.contentType,
            content: replyingTo.content,
            caption: replyingTo.caption,
          }
        : undefined,
  });
}

// Messages the server hasn't confirmed yet: queued offline, and live sends
// still on their way (or rejected). Either can already be in `messages` —
// the realtime refetch for a send can beat its own POST response, and a
// replayed queue item can arrive the same way — so anything whose
// `clientId` the loaded messages already carry is hidden rather than shown
// twice.
export function usePendingMessages(
  chatId: number,
  loadedMessages: ReadonlyArray<ChatMessage> | undefined,
) {
  const queuedMessages = useQueuedMessages(chatId);
  const outboxMessages = useOutboxMessages(chatId);
  const confirmedClientIds = useMemo(
    () =>
      new Set(
        (loadedMessages ?? []).flatMap((m) =>
          m.clientId != null ? [m.clientId] : [],
        ),
      ),
    [loadedMessages],
  );
  return useMemo(
    () =>
      [
        ...queuedMessages.map((item) => ({
          ...item,
          source: "queue" as const,
        })),
        ...outboxMessages.map((item) => ({
          ...item,
          source: "outbox" as const,
        })),
      ].filter((item) => !confirmedClientIds.has(item.clientId)),
    [queuedMessages, outboxMessages, confirmedClientIds],
  );
}
