import { useEffect, useSyncExternalStore } from "react";

// The desktop messaging dock (issue #554): which chats are open as docked
// windows along the bottom edge, which of those are minimised to their
// header, and whether the "Messaging" tab's chat list is expanded.
//
// Kept per device (localStorage) so open windows survive a reload, and per
// user, so whoever signs in next on a shared browser doesn't inherit
// someone else's open conversations.

export type DockWindow = { chatId: number; minimized: boolean };

type DockState = {
  windows: DockWindow[];
  listOpen: boolean;
};

// More than this and the oldest window is dropped — only a handful are
// ever visible at once anyway (the rest sit behind the "+N" chip).
const MAX_WINDOWS = 8;

const EMPTY: DockState = { windows: [], listOpen: false };

let userId: number | null = null;
let state: DockState = EMPTY;
const listeners = new Set<() => void>();
// Where focus was when each window was opened, so closing the window can
// hand it back (issue #554's focus management) instead of dropping it on
// <body>.
const returnFocus = new Map<number, HTMLElement>();

const storageKey = (id: number) => `chat-dock:${id}`;

function load(id: number): DockState {
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<DockState>;
    const windows = Array.isArray(parsed.windows)
      ? parsed.windows
          .filter(
            (w): w is DockWindow =>
              typeof w?.chatId === "number" && Number.isInteger(w.chatId),
          )
          .map((w) => ({ chatId: w.chatId, minimized: !!w.minimized }))
          .slice(0, MAX_WINDOWS)
      : [];
    return { windows, listOpen: !!parsed.listOpen };
  } catch {
    return EMPTY;
  }
}

function set(next: DockState) {
  state = next;
  if (userId !== null) {
    try {
      window.localStorage.setItem(storageKey(userId), JSON.stringify(state));
    } catch {
      // Storage full or blocked: the dock still works for this page load.
    }
  }
  for (const listener of listeners) listener();
}

// Points the store at the signed-in user (or nobody), loading their dock.
export function useDockUser(id: number | null): void {
  useEffect(() => {
    if (id === userId) return;
    userId = id;
    returnFocus.clear();
    state = id === null ? EMPTY : load(id);
    for (const listener of listeners) listener();
  }, [id]);
}

export function useChatDock(): DockState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => EMPTY,
  );
}

// Opens `chatId` as the front-most docked window (the one beside the
// "Messaging" tab), expanding it if it was minimised.
export function openDockedChat(chatId: number): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    returnFocus.set(chatId, active);
  }
  const rest = state.windows.filter((w) => w.chatId !== chatId);
  set({
    ...state,
    windows: [{ chatId, minimized: false }, ...rest].slice(0, MAX_WINDOWS),
  });
}

export function closeDockedChat(chatId: number): void {
  set({
    ...state,
    windows: state.windows.filter((w) => w.chatId !== chatId),
  });
  const target = returnFocus.get(chatId);
  returnFocus.delete(chatId);
  if (target?.isConnected) target.focus();
  else document.querySelector<HTMLElement>("[data-dock-tab]")?.focus();
}

export function setDockedChatMinimized(
  chatId: number,
  minimized: boolean,
): void {
  set({
    ...state,
    windows: state.windows.map((w) =>
      w.chatId === chatId ? { ...w, minimized } : w,
    ),
  });
}

export function setDockListOpen(listOpen: boolean): void {
  set({ ...state, listOpen });
}
