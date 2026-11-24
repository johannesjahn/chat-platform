import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "@tanstack/react-router";
import { chatDisplayName, takeNewlyUnread, type Chat } from "./chats";

// Opt-in browser notifications (issue #554): a system notification for a new
// direct/group message or in-app notification while the tab is in the
// background — on a desktop the app usually is one. Off until the user turns
// it on in settings, and per device (it's this browser's permission anyway).

const PREFERENCE_KEY = "browser-notifications";
const listeners = new Set<() => void>();

export type BrowserNotificationState = "unsupported" | "denied" | "off" | "on";

function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function preference(): boolean {
  try {
    return window.localStorage.getItem(PREFERENCE_KEY) === "on";
  } catch {
    return false;
  }
}

function currentState(): BrowserNotificationState {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return preference() && Notification.permission === "granted" ? "on" : "off";
}

function emit() {
  for (const listener of listeners) listener();
}

export function useBrowserNotificationState(): BrowserNotificationState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentState,
    () => "off" as const,
  );
}

// Turning it on asks for the browser's permission first (it has to come
// from a click, which is why this is only called from the settings toggle).
export async function setBrowserNotifications(on: boolean): Promise<void> {
  if (!supported()) return;
  if (on && Notification.permission === "default") {
    await Notification.requestPermission();
  }
  try {
    window.localStorage.setItem(PREFERENCE_KEY, on ? "on" : "off");
  } catch {
    // Without storage the preference can't stick; nothing else to do.
  }
  emit();
}

function preview(chat: Chat): string {
  const last = chat.lastMessage;
  if (!last) return "New message";
  if (last.contentType === "image_url") return "📷 Photo";
  if (last.contentType === "attachment")
    return `📎 ${last.caption || "Attachment"}`;
  return last.content;
}

/**
 * Shows a system notification when the unread counts go *up* while the tab
 * is hidden — the loaded chats' own counts (a new message always bumps its
 * chat onto the first page) and the bell's, so this needs no realtime
 * plumbing of its own. Muted chats don't notify (issue #900). A chat
 * notification names the chat and quotes its newest message; clicking one
 * focuses the tab and opens it.
 */
export function useBrowserNotifications({
  currentUserId,
  chats,
  unreadNotifications,
}: {
  currentUserId: number | undefined;
  chats: Chat[];
  unreadNotifications: number;
}) {
  const router = useRouter();
  const state = useBrowserNotificationState();
  const previousRef = useRef(unreadNotifications);
  const seenUnreadRef = useRef(new Map<number, number>());

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = unreadNotifications;
    const [chat] = takeNewlyUnread(seenUnreadRef.current, chats);
    if (state !== "on" || currentUserId === undefined) return;
    if (!document.hidden) return;

    if (chat) {
      const notification = new Notification(
        chatDisplayName(chat, currentUserId),
        {
          body: preview(chat),
          tag: `chat-${chat.id}`,
          icon: "/favicon-192x192.png",
        },
      );
      notification.onclick = () => {
        window.focus();
        void router.navigate({
          to: "/chats/$id",
          params: { id: String(chat.id) },
        });
        notification.close();
      };
    }
    if (unreadNotifications > previous) {
      const count = unreadNotifications - previous;
      const notification = new Notification("Chat Platform", {
        body:
          count === 1
            ? "You have a new notification."
            : `You have ${count} new notifications.`,
        tag: "notifications",
        icon: "/favicon-192x192.png",
      });
      notification.onclick = () => {
        window.focus();
        void router.navigate({ to: "/notifications" });
        notification.close();
      };
    }
  }, [state, currentUserId, chats, unreadNotifications, router]);
}
