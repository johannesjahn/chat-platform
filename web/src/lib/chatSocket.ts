import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_URL } from "./api";
import { useSession } from "./auth";
import {
  chatDetailQueryKey,
  chatMessagesQueryKey,
  chatsListQueryKey,
} from "./chats";

type ChatSocketEvent = { type: "chat_updated"; chatId: number };

// A little more than the default Bun WebSocket idle timeout — sending
// anything at all (the content is irrelevant, the server ignores incoming
// messages) resets it, so this alone keeps the connection from being closed
// as idle during a quiet conversation.
const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

function chatSocketUrl(accessToken: string): string {
  const url = new URL("/ws", API_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", accessToken);
  return url.toString();
}

// Replaces the old short-polling on the chat list / chat detail / messages
// queries: one authenticated WebSocket connection, kept open for as long as
// there's a session, that invalidates exactly the queries affected by a
// `chat_updated` event. The server only ever sends this event to users who
// are participants of the chat that changed, so this hook doesn't need to
// filter anything itself — every event it receives is relevant.
//
// Mounted once near the root (see `__root.tsx`'s `Nav`) so the nav's unread
// badge and the `/chats` list both stay live even while the user isn't
// looking at a specific conversation.
export function useChatSocket(enabled: boolean): void {
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
      socket = new WebSocket(chatSocketUrl(accessToken!));

      socket.onopen = () => {
        reconnectDelay = RECONNECT_BASE_MS;
        pingTimer = setInterval(() => socket?.send("ping"), PING_INTERVAL_MS);
      };

      socket.onmessage = (event) => {
        let parsed: ChatSocketEvent;
        try {
          parsed = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (parsed.type !== "chat_updated") return;
        void queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
        void queryClient.invalidateQueries({
          queryKey: chatDetailQueryKey(parsed.chatId),
        });
        void queryClient.invalidateQueries({
          queryKey: chatMessagesQueryKey(parsed.chatId),
        });
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
