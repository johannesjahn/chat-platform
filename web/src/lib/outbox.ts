import { onlineManager } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { fetchClient } from "./api";
import { getSession, useSession } from "./auth";
import {
  appendSentMessage,
  chatDetailQueryKey,
  chatsListQueryKey,
  markShownBeforeConfirm,
} from "./chats";
import { enqueueMessage, makeClientId } from "./offlineQueue";
import { createOutbox, type OutboxMessage } from "./outboxStore";
import { queryClient } from "./query";

export type { OutboxMessage, OutboxReplyPreview } from "./outboxStore";

// Optimistic message sends: a message shows up in the thread the moment it's
// sent, as a "sending" bubble, rather than once the POST comes back. The
// composer hands the message here and is free again straight away. The state
// machine is lib/outboxStore.ts; this wires it to the API, the query cache
// and the offline queue.
//
// Deliberately separate from the offline queue (lib/offlineQueue.ts). That
// one is for durability — localStorage, cross-tab, Web-Locks-serialized
// replay — none of which a live send needs. It's still the fallback: a send
// that turns out to have no network moves there, under the same `clientId`,
// so a request the server did store is recognised when the queue replays it.
//
// In memory, at module level rather than in the conversation's state, so a
// send outlives the view that started it — switching chats in the two-pane
// layout, or closing a docked window mid-send, doesn't drop it.
const outbox = createOutbox({
  async post(entry) {
    const result = await fetchClient.POST("/chats/{id}/messages", {
      params: { path: { id: String(entry.chatId) } },
      body: {
        contentType: entry.contentType,
        content: entry.content,
        clientId: entry.clientId,
        ...(entry.attachmentId !== undefined
          ? { attachmentId: entry.attachmentId }
          : {}),
        ...(entry.parentMessageId !== undefined
          ? { parentMessageId: entry.parentMessageId }
          : {}),
      },
    });
    return result.error ? { error: result.error } : { message: result.data };
  },

  confirmed(entry, message) {
    // If the realtime refetch already brought the message in, the thread has
    // been hiding this bubble since (it matches on `clientId`) and the append
    // is a no-op.
    appendSentMessage(queryClient, entry.chatId, message);
    void queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
    void queryClient.invalidateQueries({
      queryKey: chatDetailQueryKey(entry.chatId),
    });
  },

  // Gone offline: a text/photo-link message moves to the offline queue,
  // which replays it on reconnect. An attachment can't go there (see
  // lib/offlineQueue.ts), and a failure while still online (the server
  // unreachable) wouldn't be replayed until the next connectivity change —
  // both stay in the outbox as "failed", with Retry.
  handOff(entry) {
    if (entry.contentType === "attachment" || onlineManager.isOnline()) {
      return false;
    }
    enqueueMessage(
      entry.chatId,
      {
        contentType: entry.contentType,
        content: entry.content,
        parentMessageId: entry.parentMessageId,
      },
      entry.clientId,
    );
    return true;
  },
});

export type OutboxSend = Pick<
  OutboxMessage,
  | "contentType"
  | "content"
  | "attachmentId"
  | "attachment"
  | "parentMessageId"
  | "replyPreview"
>;

export function sendViaOutbox(chatId: number, values: OutboxSend): void {
  const clientId = makeClientId();
  markShownBeforeConfirm(clientId);
  outbox.add({
    ...values,
    clientId,
    chatId,
    ownerId: getSession()?.user.id ?? null,
    createdAt: Date.now(),
  });
}

export const retryOutboxMessage = outbox.retry;
export const dismissOutboxMessage = outbox.dismiss;

export function useOutboxMessages(chatId: number): OutboxMessage[] {
  const all = useSyncExternalStore(
    outbox.subscribe,
    outbox.getEntries,
    outbox.getEntries,
  );
  const ownerId = useSession()?.user.id ?? null;
  return useMemo(
    () =>
      all.filter(
        (entry) => entry.chatId === chatId && entry.ownerId === ownerId,
      ),
    [all, chatId, ownerId],
  );
}
