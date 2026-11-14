import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { $api } from "@/lib/api";
import {
  chatPinnedQueryKey,
  chatStarredQueryKey,
  patchCachedMessage,
  type ChatMessage,
} from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import type { ReactionEmoji } from "@/lib/reactions";

/**
 * A message's own toggles — reactions, pin, star — each patched into the
 * cache straight from its mutation's response, with the error shown under
 * the bubble when one fails. Split out of MessageBubble in issue #811.
 */
export function useMessageToggles(message: ChatMessage) {
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
  // takes the id in the path; pin takes it in the body — see src/api/chats.ts.
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

  return {
    reactionPending,
    reactionError,
    toggleReaction,
    pinPending,
    starPending,
    actionError,
    setActionError,
    togglePin,
    toggleStar,
  };
}
