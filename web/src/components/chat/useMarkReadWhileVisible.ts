import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { $api } from "@/lib/api";
import {
  applyMarkedRead,
  applyNewestMessage,
  beginOwnRead,
  holdChatInView,
} from "@/lib/chatSync";
import type { ChatMessage } from "@/lib/chats";
import { usePageVisible } from "@/lib/pageVisibility";

/**
 * Mark everything up to the newest loaded message as read once we know
 * there's something unread — keeps this chat's badge and the nav badge live.
 * Only while the page is visible (issue #663): a conversation left open in
 * a background tab mustn't read what arrives there; it's marked read when
 * the user comes back. Split out of ChatConversation in issue #811.
 *
 * While it's on screen, a new message's event refetches neither the chat
 * list nor this chat (issue #749, see lib/chatSync.ts): this is what
 * brings them up to date instead, with the chat the mark-read answers
 * with — or, when the new messages are all our own and there's nothing
 * to read, by writing the newest one in as the preview.
 */
export function useMarkReadWhileVisible({
  chatId,
  myUserId,
  chat,
  messages,
  chatFetching,
  messagesFetching,
}: {
  chatId: number;
  myUserId: number | undefined;
  chat: { unreadCount: number } | undefined;
  messages: ReadonlyArray<ChatMessage>;
  chatFetching: boolean;
  messagesFetching: boolean;
}) {
  const queryClient = useQueryClient();
  const markRead = $api.useMutation("post", "/chats/{id}/read");
  const newestMessage = messages[messages.length - 1];
  const newestMessageId = newestMessage?.id;

  const pageVisible = usePageVisible();
  useEffect(() => {
    if (!pageVisible) return;
    return holdChatInView(chatId);
  }, [chatId, pageVisible]);

  // Everything up to here is known read (or was just sent off to be).
  // `null` until the chat and its window have first settled.
  const readThroughRef = useRef<number | null>(null);
  // One mark-read at a time: a second one fired while the first is out
  // (e.g. the cached window being replaced by the fresh one on a cold load)
  // was a duplicate request. A ref, so a re-run in the same commit sees it;
  // the counter re-runs the effect once it's back.
  const readInFlightRef = useRef(false);
  const failedReadRef = useRef<number | null>(null);
  const [readsSettled, setReadsSettled] = useState(0);
  useEffect(() => {
    if (
      !pageVisible ||
      myUserId === undefined ||
      !chat ||
      newestMessage == null ||
      readInFlightRef.current ||
      // Wait for what's being fetched: the unread count and the newest
      // message may both be about to change, and marking against the stale
      // ones was the second request.
      chatFetching ||
      messagesFetching
    )
      return;
    const target = newestMessage.id;
    const readThrough = readThroughRef.current;
    if (readThrough === null && chat.unreadCount === 0) {
      readThroughRef.current = target;
      return;
    }
    if (readThrough !== null && target <= readThrough) return;
    // Don't hammer a failing request; the next message tries again.
    if (failedReadRef.current === target) return;
    const myId = myUserId;
    const somethingToRead =
      readThrough === null ||
      messages.some((m) => m.id > readThrough && m.senderId !== myId);
    if (!somethingToRead) {
      readThroughRef.current = target;
      applyNewestMessage(queryClient, chatId, newestMessage);
      return;
    }
    readInFlightRef.current = true;
    const endOwnRead = beginOwnRead(chatId);
    // `mutateAsync`, not `mutate`'s callbacks: those are skipped once this
    // view unmounts, and the bookkeeping above has to be undone regardless.
    markRead
      .mutateAsync({
        params: { path: { id: String(chatId) } },
        body: { messageId: target },
      })
      .then(
        (updated) => {
          readThroughRef.current = Math.max(
            readThroughRef.current ?? 0,
            target,
          );
          // The response is the chat as it now stands — written in, not
          // refetched, along with the list entry and the unread total.
          applyMarkedRead(queryClient, updated);
        },
        () => {
          failedReadRef.current = target;
        },
      )
      .finally(() => {
        endOwnRead();
        readInFlightRef.current = false;
        setReadsSettled((n) => n + 1);
      });
    // Only re-run when what decides it changes — `markRead` and `messages`
    // are new every render, and `newestMessage` moves with its id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    chat?.unreadCount,
    newestMessageId,
    pageVisible,
    chatFetching,
    messagesFetching,
    readsSettled,
  ]);
}
