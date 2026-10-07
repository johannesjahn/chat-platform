import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link } from "@tanstack/react-router";
import { Link2, Loader2, MessagesSquare, PlusCircle } from "lucide-react";
import { ChatListItem, ChatListItemSkeleton } from "@/components/ChatListItem";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import type { Session } from "@/lib/api";
import { chatDisplayName, useChatsList, type Chat } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { useOnlineStatus } from "@/lib/online";
import { cn } from "@/lib/utils";

// The desktop pane's quick filters (issue #554). Applied to the chats loaded
// so far — scrolling the pane keeps paging more in underneath any of them.
export type ChatListFilter = {
  query: string;
  show: "all" | "unread" | "groups";
};

function matchesFilter(
  chat: Chat,
  filter: ChatListFilter,
  currentUserId: number,
): boolean {
  if (filter.show === "unread" && chat.unreadCount === 0) return false;
  if (filter.show === "groups" && chat.type !== "group") return false;
  const query = filter.query.trim().toLowerCase();
  return (
    query === "" ||
    chatDisplayName(chat, currentUserId).toLowerCase().includes(query)
  );
}

// Holds the list's order still while the pointer is over it: a new message
// moves its chat to the top, and a row sliding out from under the cursor a
// moment before a click lands is how the wrong chat gets opened. Rows keep
// updating (previews, badges) — only their order waits until the pointer
// leaves. Chats that weren't in the frozen order (brand new ones) go first.
function useFrozenOrder(chats: Chat[]) {
  const [frozen, setFrozen] = useState<number[] | null>(null);
  const ordered = frozen
    ? [...chats].sort((a, b) => {
        const ia = frozen.indexOf(a.id);
        const ib = frozen.indexOf(b.id);
        return (ia === -1 ? -1 : ia) - (ib === -1 ? -1 : ib);
      })
    : chats;
  return {
    ordered,
    freeze: () => setFrozen(chats.map((chat) => chat.id)),
    release: () => setFrozen(null),
  };
}

/**
 * The list of the viewer's chats — loading, error, offline and empty states
 * included, paging more in as it's scrolled — shared by the phone/tablet
 * `/chats` page and the desktop two-pane layout's left pane (issue #554).
 *
 * `variant="pane"` is the denser desktop flavour: no card per row, the open
 * chat highlighted, and the order held still under the pointer.
 */
export function ChatList({
  session,
  variant = "page",
  activeChatId,
  filter,
  scrollRoot,
}: {
  session: Session;
  variant?: "page" | "pane";
  activeChatId?: number;
  filter?: ChatListFilter;
  // The scrolling element the sentinel is observed against (the pane); the
  // page variant scrolls the window.
  scrollRoot?: RefObject<HTMLElement | null>;
}) {
  const isOnline = useOnlineStatus();
  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useChatsList(true);
  const chats = data?.pages.flatMap((page) => page.chats) ?? [];
  const { ordered, freeze, release } = useFrozenOrder(chats);
  const pane = variant === "pane";
  const shown = filter
    ? ordered.filter((chat) => matchesFilter(chat, filter, session.user.id))
    : ordered;

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { root: scrollRoot?.current ?? null, rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, scrollRoot]);

  let body;
  if (isLoading) {
    body = (
      <div className={cn("flex w-full flex-col", pane ? "gap-1" : "gap-2")}>
        {Array.from({ length: 4 }).map((_, i) => (
          <ChatListItemSkeleton key={i} />
        ))}
      </div>
    );
  } else if (chats.length === 0 && error && !(error instanceof Error)) {
    // A decoded API error body (not a raw `Error`) only happens for a
    // real server-side failure — a network-level failure (offline,
    // unreachable server) throws a plain Error instead and is handled
    // by the offline branch below, not here (see errorMessage.ts's own
    // instanceof check for the same distinction).
    body = (
      <p className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        Could not load chats: {errorMessage(error)}
      </p>
    );
  } else if (chats.length === 0 && (!isOnline || error)) {
    // Already-loaded chats (persisted across reloads — see query.ts)
    // stay on screen even if a background refresh just failed; this is
    // only reached when there's truly nothing cached yet.
    body = (
      <p className="px-2 text-sm text-muted-foreground">
        You&apos;re offline, and your chats haven&apos;t been loaded on this
        device yet.
      </p>
    );
  } else if (chats.length === 0) {
    body = (
      <EmptyState
        icon={MessagesSquare}
        title="No conversations yet"
        description="Start a direct message or spin up a group with people you know."
      >
        <Button asChild>
          <Link to="/chats/new">
            <PlusCircle className="size-4" />
            New chat
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/chats/join">
            <Link2 className="size-4" />
            Join via invite
          </Link>
        </Button>
      </EmptyState>
    );
  } else if (shown.length === 0) {
    body = (
      <p className="px-2 py-6 text-center text-sm text-muted-foreground">
        No chats match.
      </p>
    );
  } else {
    body = (
      <ul
        role="list"
        className={cn("flex w-full flex-col", pane ? "gap-0.5" : "gap-2")}
        onPointerEnter={pane ? freeze : undefined}
        onPointerLeave={pane ? release : undefined}
      >
        {shown.map((chat, i) => (
          <li key={chat.id}>
            <ChatListItem
              chat={chat}
              currentUserId={session.user.id}
              active={chat.id === activeChatId}
              density={pane ? "compact" : "comfortable"}
              style={{ "--stagger-index": Math.min(i, 8) } as CSSProperties}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      {body}
      <div
        ref={sentinelRef}
        data-testid="chats-sentinel"
        className="h-1 w-full shrink-0"
      />
      {isFetchingNextPage && (
        <Loader2 className="size-5 shrink-0 animate-spin self-center text-muted-foreground" />
      )}
    </>
  );
}
