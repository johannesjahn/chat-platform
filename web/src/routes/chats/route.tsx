import { useEffect, useRef, useState } from "react";
import {
  createFileRoute,
  Link,
  Outlet,
  useMatch,
  useNavigate,
} from "@tanstack/react-router";
import { Link2, MessagesSquare, PlusCircle, Search } from "lucide-react";
import { ChatList, type ChatListFilter } from "@/components/ChatList";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/auth";
import { useChatsList, useChatsTwoPane, type Chat } from "@/lib/chats";
import { cn } from "@/lib/utils";
import { useImmersiveShell } from "@/lib/viewport";

export const Route = createFileRoute("/chats")({
  component: ChatsLayout,
});

const SHOW_OPTIONS: ReadonlyArray<{
  value: ChatListFilter["show"];
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "groups", label: "Groups" },
];

/**
 * The layout around every `/chats/*` page.
 *
 * Below `lg` it's a pass-through: the list and the conversation stay
 * separate full pages, exactly as before. At `lg`+ it's the two-pane
 * messenger — the chat list on the left, whatever `/chats/*` page is open on
 * the right (a conversation, the new-chat form, an invite) — so switching
 * conversations is one click, the list keeps its scroll position, and other
 * chats' unread badges stay in view while typing. The whole layout fills the
 * viewport (the immersive shell, minus the phone-only parts) and each pane
 * scrolls inside itself.
 */
function ChatsLayout() {
  const session = useSession();
  const twoPane = useChatsTwoPane();
  useImmersiveShell(twoPane);
  const activeId = useMatch({ from: "/chats/$id", shouldThrow: false })?.params
    .id;
  const activeChatId = activeId === undefined ? undefined : Number(activeId);
  const { data } = useChatsList(!!session);
  const chats = data?.pages.flatMap((page) => page.chats) ?? [];
  useChatSwitchKeys(chats, activeChatId);

  const [filter, setFilter] = useState<ChatListFilter>({
    query: "",
    show: "all",
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);

  if (!twoPane || !session) return <Outlet />;

  return (
    <div className="flex min-h-0 grow basis-0">
      <aside
        aria-label="Conversations"
        className="flex w-80 shrink-0 flex-col border-r border-border bg-card/40 xl:w-96"
      >
        <div className="flex h-16 shrink-0 items-center gap-2 border-b border-border px-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <MessagesSquare className="size-5 text-primary" />
            <GradientText>Chats</GradientText>
          </h2>
          <div className="ml-auto flex items-center gap-1">
            <Button
              asChild
              size="icon"
              variant="ghost"
              aria-label="Join via invite"
              title="Join via invite"
            >
              <Link to="/chats/join">
                <Link2 className="size-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="icon"
              aria-label="New chat"
              title="New chat"
              className="rounded-full"
            >
              <Link to="/chats/new">
                <PlusCircle className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={filter.query}
              onChange={(e) =>
                setFilter((prev) => ({ ...prev, query: e.target.value }))
              }
              placeholder="Filter chats"
              aria-label="Filter chats"
              className="h-9 pl-8"
            />
          </div>
          <div
            role="radiogroup"
            aria-label="Show"
            className="flex gap-1 rounded-lg bg-background/50 p-0.5"
          >
            {SHOW_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={filter.show === option.value}
                onClick={() =>
                  setFilter((prev) => ({ ...prev, show: option.value }))
                }
                className={cn(
                  "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  filter.show === option.value
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div
          ref={scrollRef}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-2"
        >
          <ChatList
            session={session}
            variant="pane"
            activeChatId={activeChatId}
            filter={filter}
            scrollRoot={scrollRef}
          />
        </div>
      </aside>
      {/* The page beside the list. A conversation fills it exactly and
          scrolls its own thread; the other `/chats/*` pages are ordinary
          documents and scroll the pane. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}

// `Alt+↑/↓` opens the previous/next chat in the list, and with Shift the
// previous/next one that has something unread (issue #554). It doesn't wrap
// around: the ends of the list are where it stops. With no chat open, ↓
// starts from the top and ↑ from the bottom.
function useChatSwitchKeys(chats: Chat[], activeChatId: number | undefined) {
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (chats.length === 0) return;
      if (document.querySelector("[aria-modal=true]")) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const current = chats.findIndex((chat) => chat.id === activeChatId);
      const start = current === -1 ? (step === 1 ? -1 : chats.length) : current;
      for (let i = start + step; i >= 0 && i < chats.length; i += step) {
        const chat = chats[i]!;
        if (event.shiftKey && chat.unreadCount === 0) continue;
        void navigate({ to: "/chats/$id", params: { id: String(chat.id) } });
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chats, activeChatId, navigate]);
}
