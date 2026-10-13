import { useEffect, useRef, useSyncExternalStore } from "react";
import { useChatsTwoPane } from "./chats";
import { useMediaQuery } from "./media";

// The desktop chat details panel (issue #563): a third pane beside an open
// conversation at `xl`+, holding what the group settings modal holds plus
// pinned/starred messages, shared media, and — for a direct chat — the
// other person. Below `xl` the modal stays.

// Tailwind's `xl` (80rem = 1280px at the default root size).
export const WIDE_DESKTOP_MEDIA_QUERY = "(min-width: 80rem)";

/**
 * Whether chat details show as the side panel rather than the modal: the
 * two-pane messenger, with room for a third pane.
 */
export function useChatDetailsAsPanel(): boolean {
  const twoPane = useChatsTwoPane();
  const wide = useMediaQuery(WIDE_DESKTOP_MEDIA_QUERY);
  return twoPane && wide;
}

// Whether the panel is open, remembered per device. Closed until the first
// time someone opens it.
const STORAGE_KEY = "chat-details-open";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let open: boolean | null = null;

export function setChatDetailsOpen(next: boolean) {
  open = next;
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Without storage it just won't outlive the page.
  }
  for (const listener of listeners) listener();
}

export function useChatDetailsOpen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => (open ??= read()),
    () => false,
  );
}

// "Show this message in the thread" from the panel (a pinned, starred or
// media row). The panel is a sibling of the conversation rather than inside
// it, so the request travels through here to the conversation that has the
// chat open — which pages back through history to find it if need be.
type JumpListener = (chatId: number, messageId: number) => void;
const jumpListeners = new Set<JumpListener>();

export function requestJumpToMessage(chatId: number, messageId: number) {
  for (const listener of jumpListeners) listener(chatId, messageId);
}

export function useJumpRequests(
  chatId: number | undefined,
  onJump: (messageId: number) => void,
) {
  const onJumpRef = useRef(onJump);
  useEffect(() => {
    onJumpRef.current = onJump;
  });
  useEffect(() => {
    if (chatId === undefined) return;
    const listener: JumpListener = (target, messageId) => {
      if (target === chatId) onJumpRef.current(messageId);
    };
    jumpListeners.add(listener);
    return () => {
      jumpListeners.delete(listener);
    };
  }, [chatId]);
}
