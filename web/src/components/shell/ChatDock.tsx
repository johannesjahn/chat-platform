import { type KeyboardEvent, useState, useSyncExternalStore } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  ChevronUp,
  Maximize2,
  MessagesSquare,
  Minus,
  Search,
  X,
} from "lucide-react";
import { ChatAvatar } from "@/components/chat/ChatAvatar";
import { ChatConversation } from "@/components/chat/ChatConversation";
import { TypingDots } from "@/components/reactbits/TypingDots";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import type { Session } from "@/lib/api";
import { useSession } from "@/lib/auth";
import {
  closeDockedChat,
  openDockedChat,
  setDockedChatMinimized,
  setDockListOpen,
  useChatDock,
  useDockUser,
  type DockWindow,
} from "@/lib/chatDock";
import {
  chatDisplayName,
  formatChatTimestamp,
  useChatDetail,
  useChatsList,
  useTotalUnreadCount,
  type Chat,
} from "@/lib/chats";
import { useIsDesktop } from "@/lib/media";
import { useIsOnline } from "@/lib/presence";
import { useTypingUsers } from "@/lib/typing";
import { cn } from "@/lib/utils";

// Widths the dock lays out with, in px: the "Messaging" tab, one window,
// the gap between them, and the screen-edge margin. The sidebar's width
// comes off the top before anything is fitted.
const TAB_WIDTH = 288;
const WINDOW_WIDTH = 328;
const GAP = 12;
const EDGE = 16;
const MAX_VISIBLE_WINDOWS = 3;

function useWindowWidth(): number {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("resize", onChange);
      return () => window.removeEventListener("resize", onChange);
    },
    () => window.innerWidth,
    () => 0,
  );
}

// How many windows fit beside the tab without running under the sidebar.
function visibleWindowCount(viewport: number): number {
  const sidebar = viewport >= 1280 ? 256 : 76;
  const room = viewport - sidebar - EDGE * 2 - TAB_WIDTH;
  return Math.max(
    1,
    Math.min(MAX_VISIBLE_WINDOWS, Math.floor(room / (WINDOW_WIDTH + GAP))),
  );
}

/**
 * The desktop messaging dock (issue #554), LinkedIn/Facebook style: a
 * "Messaging" tab at the bottom-right of every page with the total unread
 * count, which expands into a compact chat list, and docked chat windows
 * beside it — so chatting never means leaving the feed, a profile or a
 * game hub.
 *
 * Windows render the very same `ChatConversation` the `/chats/$id` page
 * does, at its docked density, so reading a message there marks it read
 * exactly as the full view would. Hidden on `/chats/*` (the two-pane view
 * already is the messenger) and below `lg` (the phone layout keeps the
 * immersive full-page chat).
 */
export function ChatDock() {
  const session = useSession();
  const isDesktop = useIsDesktop();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useDockUser(session?.user.id ?? null);
  const onChats = pathname === "/chats" || pathname.startsWith("/chats/");
  if (!session || !isDesktop || onChats) return null;
  return <Dock session={session} />;
}

function Dock({ session }: { session: Session }) {
  const { windows, listOpen } = useChatDock();
  const viewport = useWindowWidth();
  const visible = windows.slice(0, visibleWindowCount(viewport));
  const overflow = windows.slice(visible.length);

  return (
    // The whole strip ignores the pointer except for its panels, so the
    // empty space between them doesn't swallow clicks on the page below.
    <div
      data-chat-dock
      className="pointer-events-none fixed bottom-0 right-4 z-30 flex flex-row-reverse items-end gap-3"
    >
      <MessagingTab session={session} open={listOpen} />
      {visible.map((w) => (
        <DockedChatWindow
          key={w.chatId}
          window={w}
          currentUserId={session.user.id}
        />
      ))}
      {overflow.length > 0 && (
        <OverflowChip windows={overflow} currentUserId={session.user.id} />
      )}
    </div>
  );
}

const panelClassName =
  "pointer-events-auto flex flex-col overflow-hidden rounded-t-2xl border border-b-0 border-border bg-popover text-popover-foreground shadow-2xl";

function MessagingTab({ session, open }: { session: Session; open: boolean }) {
  const unread = useTotalUnreadCount(true);
  const { data } = useChatsList(true);
  const chats = data?.pages.flatMap((page) => page.chats) ?? [];
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? chats.filter((chat) =>
        chatDisplayName(chat, session.user.id).toLowerCase().includes(needle),
      )
    : chats;

  return (
    <section aria-label="Messaging" className={cn(panelClassName, "w-72")}>
      <button
        type="button"
        data-dock-tab
        aria-expanded={open}
        onClick={() => setDockListOpen(!open)}
        className="flex h-12 items-center gap-2.5 px-4 text-left text-sm font-semibold outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40"
      >
        <MessagesSquare className="size-4 text-primary" />
        Messaging
        {unread > 0 && (
          <span
            key={unread}
            aria-label={`${unread} unread`}
            className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground motion-safe:animate-badge-pop"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
        <ChevronUp
          className={cn(
            "ml-auto size-4 text-muted-foreground transition-transform duration-300",
            open && "rotate-180",
          )}
        />
      </button>
      <Collapse open={open}>
        <div className="flex h-[min(26rem,calc(var(--app-height,100dvh)-8rem))] flex-col border-t border-border">
          <div className="relative px-3 py-2">
            <Search className="pointer-events-none absolute left-5.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="h-8 w-full rounded-lg border border-input bg-background pl-8 pr-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
          <ul
            role="list"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-2"
          >
            {shown.map((chat) => (
              <li key={chat.id}>
                <DockChatRow chat={chat} currentUserId={session.user.id} />
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                {chats.length === 0
                  ? "No conversations yet."
                  : "No chats match."}
              </li>
            )}
          </ul>
          <Link
            to="/chats"
            className="border-t border-border px-4 py-2 text-center text-xs font-medium text-primary hover:bg-accent/40"
          >
            Open Chats
          </Link>
        </div>
      </Collapse>
    </section>
  );
}

function DockChatRow({
  chat,
  currentUserId,
}: {
  chat: Chat;
  currentUserId: number;
}) {
  const name = chatDisplayName(chat, currentUserId);
  const last = chat.lastMessage;
  return (
    <button
      type="button"
      onClick={() => openDockedChat(chat.id)}
      className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
    >
      <ChatAvatar chat={chat} currentUserId={currentUserId} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "truncate text-sm",
              chat.unreadCount > 0 ? "font-semibold" : "font-medium",
            )}
          >
            {name}
          </span>
          {last && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {formatChatTimestamp(last.createdAt)}
            </span>
          )}
        </span>
        <span className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "truncate text-xs",
              chat.unreadCount > 0
                ? "text-foreground"
                : "text-muted-foreground",
            )}
          >
            {!last
              ? "No messages yet"
              : last.contentType === "text"
                ? last.content
                : last.contentType === "image_url"
                  ? "Photo"
                  : "Attachment"}
          </span>
          {chat.unreadCount > 0 && (
            <span className="flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function DockedChatWindow({
  window: { chatId, minimized },
  currentUserId,
}: {
  window: DockWindow;
  currentUserId: number;
}) {
  const { data: chat } = useChatDetail(chatId, true);
  const name = chat ? chatDisplayName(chat, currentUserId) : "Chat";
  const other =
    chat?.type === "direct"
      ? chat.participants.find((p) => p.userId !== currentUserId)
      : undefined;
  const online = useIsOnline(other?.userId);
  const typing = useTypingUsers(chatId).filter(
    (t) => t.userId !== currentUserId,
  );
  const subtitle =
    typing.length > 0
      ? null
      : chat?.type === "group"
        ? `${chat.participants.length} participants`
        : online
          ? "Online"
          : "Direct message";

  // Escape closes the window — unless something inside it used the key
  // first (cancelling a reply or an edit, closing a menu).
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    closeDockedChat(chatId);
  }

  return (
    <section
      aria-label={`Chat with ${name}`}
      onKeyDown={onKeyDown}
      className={cn(
        panelClassName,
        "motion-safe:animate-banner-rise",
        minimized
          ? "w-60"
          : "h-[min(28rem,calc(var(--app-height,100dvh)-5rem))]",
      )}
      style={minimized ? undefined : { width: WINDOW_WIDTH }}
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border pl-2 pr-1">
        <button
          type="button"
          onClick={() => setDockedChatMinimized(chatId, !minimized)}
          aria-label={
            minimized
              ? `Expand chat with ${name}`
              : `Minimize chat with ${name}`
          }
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
        >
          {chat && (
            <ChatAvatar chat={chat} currentUserId={currentUserId} size="sm" />
          )}
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-semibold">{name}</span>
            {typing.length > 0 ? (
              <span className="flex items-center gap-1 text-[11px] text-primary">
                <TypingDots className="scale-75" />
                typing…
              </span>
            ) : (
              <span className="truncate text-[11px] text-muted-foreground">
                {subtitle}
              </span>
            )}
          </span>
          {minimized && chat && chat.unreadCount > 0 && (
            <span className="flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {chat.unreadCount}
            </span>
          )}
        </button>
        {!minimized && (
          <Button
            asChild
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label="Open full conversation"
            title="Open full conversation"
          >
            <Link to="/chats/$id" params={{ id: String(chatId) }}>
              <Maximize2 className="size-3.5" />
            </Link>
          </Button>
        )}
        {!minimized && (
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label="Minimize"
            title="Minimize"
            onClick={() => setDockedChatMinimized(chatId, true)}
          >
            <Minus className="size-3.5" />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={`Close chat with ${name}`}
          title="Close"
          onClick={() => closeDockedChat(chatId)}
        >
          <X className="size-3.5" />
        </Button>
      </header>
      {!minimized && (
        <ChatConversation key={chatId} chatId={chatId} variant="docked" />
      )}
    </section>
  );
}

// The windows that don't fit beside the others: one chip that lists them,
// any of which can be brought to the front.
function OverflowChip({
  windows,
  currentUserId,
}: {
  windows: DockWindow[];
  currentUserId: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pointer-events-auto relative mb-2">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${windows.length} more open chat${windows.length === 1 ? "" : "s"}`}
        onClick={() => setOpen(!open)}
        className="flex h-10 min-w-10 items-center justify-center rounded-full border border-border bg-popover px-3 text-sm font-semibold shadow-xl transition-colors hover:bg-accent"
      >
        +{windows.length}
      </button>
      {open && (
        <ul
          role="list"
          className="absolute bottom-full right-0 mb-2 w-56 rounded-2xl border border-border bg-popover p-1.5 shadow-2xl motion-safe:animate-pop-open"
        >
          {windows.map((w) => (
            <li key={w.chatId}>
              <OverflowRow
                chatId={w.chatId}
                currentUserId={currentUserId}
                onPick={() => setOpen(false)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OverflowRow({
  chatId,
  currentUserId,
  onPick,
}: {
  chatId: number;
  currentUserId: number;
  onPick: () => void;
}) {
  const { data: chat } = useChatDetail(chatId, true);
  if (!chat) return null;
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => {
          onPick();
          openDockedChat(chatId);
        }}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-accent/50"
      >
        <ChatAvatar chat={chat} currentUserId={currentUserId} size="sm" />
        <span className="truncate">{chatDisplayName(chat, currentUserId)}</span>
      </button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={`Close chat with ${chatDisplayName(chat, currentUserId)}`}
        onClick={() => closeDockedChat(chatId)}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}
