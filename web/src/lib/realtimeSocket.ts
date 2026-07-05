import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_URL } from "./api";
import { useSession } from "./auth";
import {
  chatDetailQueryKey,
  chatMessagesQueryKey,
  chatsListQueryKey,
} from "./chats";
import { postDetailQueryKeyPrefix, postsFeedQueryKey } from "./posts";

type RealtimeSocketEvent =
  | { type: "chat_updated"; chatId: number }
  | { type: "post_changed"; postId: number };

// A little more than the default Bun WebSocket idle timeout — sending
// anything at all (the content is irrelevant, the server ignores incoming
// messages) resets it, so this alone keeps the connection from being closed
// as idle during a quiet conversation.
const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

function realtimeSocketUrl(accessToken: string): string {
  const url = new URL("/ws", API_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", accessToken);
  return url.toString();
}

// Replaces the old short-polling on the chat list / chat detail / messages
// queries, and adds the same live behavior to the posts feed: one
// authenticated WebSocket connection, kept open for as long as there's a
// session, that invalidates exactly the queries affected by each event.
//
// `chat_updated` is scoped server-side to a chat's participants, so this
// hook doesn't need to filter it. `post_changed` goes out to every connected
// user — the feed has no notion of participants, anyone signed in sees it.
//
// Mounted once near the root (see `__root.tsx`'s `Nav`) so the nav's unread
// badge, the `/chats` list, and the `/` feed all stay live even when the
// user isn't looking at them.
export function useRealtimeSocket(enabled: boolean): void {
  const queryClient = useQueryClient();
  const session = useSession();
  const accessToken = enabled ? session?.accessToken : undefined;

  useEffect(() => {
    if (!accessToken) return;

    let socket: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelay = RECONNECT_BASE_MS;
    let stopped = false;

    function connect() {
      socket = new WebSocket(realtimeSocketUrl(accessToken!));

      socket.onopen = () => {
        reconnectDelay = RECONNECT_BASE_MS;
        pingTimer = setInterval(() => socket?.send("ping"), PING_INTERVAL_MS);
      };

      socket.onmessage = (event) => {
        let parsed: RealtimeSocketEvent;
        try {
          parsed = JSON.parse(event.data as string);
        } catch {
          return;
        }
        switch (parsed.type) {
          case "chat_updated":
            void queryClient.invalidateQueries({
              queryKey: chatsListQueryKey,
            });
            void queryClient.invalidateQueries({
              queryKey: chatDetailQueryKey(parsed.chatId),
            });
            void queryClient.invalidateQueries({
              queryKey: chatMessagesQueryKey(parsed.chatId),
            });
            break;
          case "post_changed":
            void queryClient.invalidateQueries({
              queryKey: postsFeedQueryKey,
            });
            void queryClient.invalidateQueries({
              queryKey: postDetailQueryKeyPrefix,
            });
            break;
        }
      };

      socket.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (stopped) return;
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
          connect();
        }, reconnectDelay);
      };
    }

    connect();

    return () => {
      stopped = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [accessToken, queryClient]);
}
