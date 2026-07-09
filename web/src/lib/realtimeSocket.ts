import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_URL, fetchClient } from "./api";
import { useSession } from "./auth";
import { classifyChatVersion, recordChatVersion } from "./chatVersions";
import {
  chatDetailQueryKey,
  chatMessagesQueryKey,
  chatsListQueryKey,
} from "./chats";
import { postDetailQueryKeyPrefix, postsFeedQueryKey } from "./posts";
import { resetPresence, setUserOnline } from "./presence";
import { noteTyping } from "./typing";

type RealtimeSocketEvent =
  | { type: "chat_updated"; chatId: number; version: number }
  | { type: "post_changed"; postId: number }
  | { type: "presence"; userId: number; online: boolean }
  | { type: "typing"; chatId: number; userId: number; username: string };

// A little more than the default Bun WebSocket idle timeout — sending
// anything at all (the content is irrelevant, the server ignores incoming
// messages) resets it, so this alone keeps the connection from being closed
// as idle during a quiet conversation.
const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

function realtimeSocketUrl(ticket: string): string {
  const url = new URL("/ws", API_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
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
// `presence`/`typing` don't touch React Query at all — they update the
// standalone stores in lib/presence.ts and lib/typing.ts instead, since
// there's no REST resource behind either to invalidate.
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

    async function connect() {
      // Mint a short-lived, single-use ticket over authenticated REST (see
      // src/WsTicket.ts) rather than putting the long-lived access token
      // itself on the `/ws` URL, where it'd be liable to end up in access
      // logs, proxy logs, or browser history (see issue #26).
      const { data, error } = await fetchClient.POST("/realtime/ws-ticket");
      if (stopped) return;
      if (error || !data) {
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
          void connect();
        }, reconnectDelay);
        return;
      }

      socket = new WebSocket(realtimeSocketUrl(data.ticket));

      socket.onopen = () => {
        reconnectDelay = RECONNECT_BASE_MS;
        pingTimer = setInterval(() => socket?.send("ping"), PING_INTERVAL_MS);
        // A dropped connection can mean any number of users went
        // offline/online without this client hearing about it — start
        // presence clean and let the fresh connection's initial snapshot
        // (see RealtimeSocket.ts) repopulate it.
        resetPresence();
      };

      socket.onmessage = (event) => {
        let parsed: RealtimeSocketEvent;
        try {
          parsed = JSON.parse(event.data as string);
        } catch {
          return;
        }
        switch (parsed.type) {
          case "chat_updated": {
            // `version` (see Chat.version, src/db/schema.ts) lets this be
            // deterministic instead of blindly refetching on every push
            // (issue #55): a "stale" classification means this event is a
            // redelivery of something already applied (e.g. after a
            // Redis/WS reconnect resends what was in flight) and there's
            // nothing new to fetch; "gap" means at least one update was
            // missed in between and is logged so it's visible, but the
            // recovery is the same full refetch either way — there's no
            // "fetch only the delta" endpoint yet (that's the follow-on
            // sub-task this one exists to unblock).
            const classification = classifyChatVersion(
              parsed.chatId,
              parsed.version,
            );
            if (classification === "stale") break;
            if (classification === "gap") {
              console.warn(
                `Realtime: missed update(s) for chat ${parsed.chatId} (jumped to version ${parsed.version})`,
              );
            }
            recordChatVersion(parsed.chatId, parsed.version);
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
          }
          case "post_changed":
            void queryClient.invalidateQueries({
              queryKey: postsFeedQueryKey,
            });
            void queryClient.invalidateQueries({
              queryKey: postDetailQueryKeyPrefix,
            });
            break;
          case "presence":
            setUserOnline(parsed.userId, parsed.online);
            break;
          case "typing":
            noteTyping(parsed.chatId, parsed.userId, parsed.username);
            break;
        }
      };

      socket.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (stopped) return;
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
          void connect();
        }, reconnectDelay);
      };
    }

    void connect();

    return () => {
      stopped = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [accessToken, queryClient]);
}
