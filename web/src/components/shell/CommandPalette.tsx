import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Bell,
  CornerDownLeft,
  FileText,
  Gamepad2,
  House,
  Loader2,
  MessageSquare,
  MessagesSquare,
  PenSquare,
  Search,
  Settings,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { SearchHighlight } from "@/components/SearchHighlight";
import { useSession } from "@/lib/auth";
import { chatDisplayName, useChatsList, type Chat } from "@/lib/chats";
import { useTransitionState } from "@/lib/motion";
import { MIN_SEARCH_QUERY_LENGTH, useSearchAll } from "@/lib/search";
import { closeOverlay, getPaletteMode, useOverlayOpen } from "@/lib/shell";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { userAvatarName, userHandle, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";

// How many rows of each kind the palette lists.
const CHAT_LIMIT = 6;
const RESULT_LIMIT = 4;

type PaletteItem = {
  key: string;
  group: string;
  label: ReactNode;
  // Plain text for the option's accessible name when `label` is markup.
  text: string;
  hint?: ReactNode;
  leading: ReactNode;
  onSelect: () => void;
};

/**
 * The desktop quick switcher and search (issue #554), opened with
 * `Ctrl/⌘+K` or `/` from anywhere, or the sidebar's search button.
 *
 * One box does both jobs the issue asks of the header: with nothing typed
 * it's a switcher — your most recent chats and the app's main places — and
 * as you type it filters your chats by name and, past
 * `MIN_SEARCH_QUERY_LENGTH`, live-searches people, posts and messages
 * through the same `GET /search` the results page uses. ↑/↓ move, Enter
 * opens, and the last row is always "all results" on `/search`.
 *
 * It's a combobox over a listbox: focus stays in the input and the active
 * row is announced via `aria-activedescendant`.
 */
export function CommandPalette() {
  const open = useOverlayOpen("palette");
  const { ref, mounted, phase } = useTransitionState<HTMLDivElement>(open);
  if (!mounted) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]"
      inert={!open}
    >
      <div
        className={cn(
          "absolute inset-0 bg-background/70 backdrop-blur-sm",
          phase === "exiting"
            ? "motion-safe:animate-backdrop-fade-out"
            : "motion-safe:animate-backdrop-blur-in",
        )}
        onClick={() => closeOverlay("palette")}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Search and quick switcher"
        className={cn(
          "relative flex max-h-[min(36rem,calc(var(--app-height,100dvh)-16vh))] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl",
          phase === "exiting"
            ? "motion-safe:animate-pop-close"
            : "motion-safe:animate-dialog-in",
        )}
      >
        {/* Remounted per opening so the query and selection start fresh. */}
        {open && <PaletteBody />}
      </div>
    </div>
  );
}

function PaletteBody() {
  const session = useSession();
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState("");
  // Fixed for this opening (the body remounts per opening). In search mode
  // nothing is highlighted until ↓ — Enter means "all results" — while the
  // switcher highlights its top match so Enter opens it.
  const [mode] = useState(getPaletteMode);
  const initialActive = mode === "search" ? -1 : 0;
  const [active, setActive] = useState(initialActive);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Focus goes back where it was once the palette closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const trimmed = query.trim();
  const debounced = useDebouncedValue(trimmed, 200);
  const searching = debounced.length >= MIN_SEARCH_QUERY_LENGTH;
  const { data: chatsData } = useChatsList(!!session);
  const { data: results, isFetching } = useSearchAll(
    debounced,
    !!session && searching,
  );

  const close = () => closeOverlay("palette");
  const go = (action: () => void) => () => {
    close();
    action();
  };

  const items = useMemo<PaletteItem[]>(() => {
    if (!session) return [];
    const me = session.user.id;
    const chats = chatsData?.pages.flatMap((page) => page.chats) ?? [];
    const needle = trimmed.toLowerCase();
    const matchingChats = (
      needle
        ? chats.filter((chat) =>
            chatDisplayName(chat, me).toLowerCase().includes(needle),
          )
        : chats
    ).slice(0, CHAT_LIMIT);

    const list: PaletteItem[] = matchingChats.map((chat) => ({
      key: `chat-${chat.id}`,
      group: needle ? "Chats" : "Recent chats",
      label: chatDisplayName(chat, me),
      text: chatDisplayName(chat, me),
      hint:
        chat.unreadCount > 0 ? (
          <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
            {chat.unreadCount}
          </span>
        ) : undefined,
      leading: <ChatGlyph chat={chat} me={me} />,
      onSelect: go(() =>
        navigate({ to: "/chats/$id", params: { id: String(chat.id) } }),
      ),
    }));

    if (!needle) {
      const places: [string, LucideIcon, () => void][] = [
        ["Feed", House, () => navigate({ to: "/" })],
        ["Chats", MessagesSquare, () => navigate({ to: "/chats" })],
        ["Notifications", Bell, () => navigate({ to: "/notifications" })],
        ["Users", Users, () => navigate({ to: "/users" })],
        ["Games", Gamepad2, () => navigate({ to: "/games" })],
        ["New chat", UserPlus, () => navigate({ to: "/chats/new" })],
        ["New post", PenSquare, () => navigate({ to: "/posts/new" })],
        ["Settings", Settings, () => navigate({ to: "/settings" })],
      ];
      for (const [label, icon, action] of places) {
        list.push({
          key: `go-${label}`,
          group: "Go to",
          label,
          text: label,
          leading: <IconGlyph icon={icon} />,
          onSelect: go(action),
        });
      }
      return list;
    }

    if (searching && results) {
      for (const hit of results.users.results.slice(0, RESULT_LIMIT)) {
        list.push({
          key: `user-${hit.user.id}`,
          group: "People",
          label: userLabel(hit.user),
          text: userLabel(hit.user),
          hint: userHandle(hit.user),
          leading: (
            <Avatar
              name={userAvatarName(hit.user)}
              avatarUrl={hit.user.avatarUrl}
              avatarVariants={hit.user.avatarVariants}
              size="sm"
            />
          ),
          onSelect: go(() =>
            navigate({
              to: "/users/$id",
              params: { id: String(hit.user.id) },
            }),
          ),
        });
      }
      for (const hit of results.posts.results.slice(0, RESULT_LIMIT)) {
        const text = hit.snippet.map((s) => s.text).join("");
        list.push({
          key: `post-${hit.id}`,
          group: "Posts",
          label: <SearchHighlight snippet={hit.snippet} />,
          text: `Post by ${userLabel(hit.author)}: ${text}`,
          hint: userLabel(hit.author),
          leading: <IconGlyph icon={FileText} />,
          onSelect: go(() =>
            navigate({ to: "/posts/$id", params: { id: String(hit.id) } }),
          ),
        });
      }
      for (const hit of results.messages.results.slice(0, RESULT_LIMIT)) {
        const text = hit.snippet.map((s) => s.text).join("");
        list.push({
          key: `message-${hit.id}`,
          group: "Messages",
          label: <SearchHighlight snippet={hit.snippet} />,
          text: `Message from ${userLabel(hit.sender)}: ${text}`,
          hint: userLabel(hit.sender),
          leading: <IconGlyph icon={MessageSquare} />,
          onSelect: go(() =>
            navigate({
              to: "/chats/$id",
              params: { id: String(hit.chatId) },
              search: { message: hit.id },
            }),
          ),
        });
      }
    }

    list.push({
      key: "all-results",
      group: "Search",
      label: (
        <>
          All results for <span className="font-semibold">“{trimmed}”</span>
        </>
      ),
      text: `All results for ${trimmed}`,
      leading: <IconGlyph icon={Search} />,
      onSelect: go(() => navigate({ to: "/search", search: { q: trimmed } })),
    });
    return list;
    // `go`/`navigate` are stable in behaviour; the list only depends on data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, chatsData, trimmed, searching, results]);

  // Keep the selection on a real row as the list changes under it (-1 is
  // the search box itself).
  const activeIndex = Math.min(active, items.length - 1);
  const activeItem = items[activeIndex];

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(
        activeIndex === -1 && step === -1
          ? items.length - 1
          : (activeIndex + step + items.length) % items.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeItem) activeItem.onSelect();
      else if (trimmed) {
        close();
        void navigate({ to: "/search", search: { q: trimmed } });
      }
    } else if (event.key === "Tab") {
      // Nothing else in the dialog takes focus; keep it in the box.
      event.preventDefault();
    }
  }

  const optionId = (index: number) => `${listId}-${index}`;

  return (
    <>
      <div className="flex items-center gap-3 border-b border-border px-4">
        {isFetching && searching ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Search className="size-4 shrink-0 text-muted-foreground" />
        )}
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeItem ? optionId(activeIndex) : undefined}
          aria-autocomplete="list"
          aria-label="Search chats, people, posts and messages"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(initialActive);
          }}
          onKeyDown={onKeyDown}
          placeholder={
            mode === "search"
              ? "Search people, posts and messages…"
              : "Jump to a chat or page…"
          }
          className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
        <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          Esc
        </kbd>
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Results"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
      >
        {!session ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            Log in to search.
          </p>
        ) : (
          items.map((item, index) => (
            <PaletteRow
              key={item.key}
              id={optionId(index)}
              index={index}
              item={item}
              active={index === activeIndex}
              showGroup={index === 0 || items[index - 1]!.group !== item.group}
              onHover={() => setActive(index)}
            />
          ))
        )}
      </div>
      <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <kbd className="rounded border border-border px-1">↑</kbd>
          <kbd className="rounded border border-border px-1">↓</kbd>
          to move
        </span>
        <span className="flex items-center gap-1">
          <CornerDownLeft className="size-3" />
          to open
        </span>
      </div>
    </>
  );
}

function PaletteRow({
  id,
  index,
  item,
  active,
  showGroup,
  onHover,
}: {
  id: string;
  index: number;
  item: PaletteItem;
  active: boolean;
  showGroup: boolean;
  onHover: () => void;
}) {
  return (
    <>
      {showGroup && (
        <div
          role="presentation"
          className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground first:pt-1"
        >
          {item.group}
        </div>
      )}
      <div
        id={id}
        role="option"
        aria-selected={active}
        aria-label={item.text}
        data-index={index}
        onMouseMove={onHover}
        // `mousedown` would steal focus from the input before `click` lands.
        onMouseDown={(e) => e.preventDefault()}
        onClick={item.onSelect}
        className={cn(
          "flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm",
          active ? "bg-accent text-accent-foreground" : "text-foreground",
        )}
      >
        <span className="flex size-7 shrink-0 items-center justify-center">
          {item.leading}
        </span>
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.hint && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {item.hint}
          </span>
        )}
      </div>
    </>
  );
}

function IconGlyph({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-primary">
      <Icon className="size-3.5" />
    </span>
  );
}

function ChatGlyph({ chat, me }: { chat: Chat; me: number }) {
  const other =
    chat.type === "direct"
      ? chat.participants.find((p) => p.userId !== me)
      : undefined;
  if (other) {
    return (
      <Avatar
        name={userAvatarName(other)}
        avatarUrl={other.avatarUrl}
        avatarVariants={other.avatarVariants}
        size="sm"
      />
    );
  }
  if (chat.avatarVariants) {
    return (
      <Avatar
        name={chatDisplayName(chat, me)}
        avatarVariants={chat.avatarVariants}
        size="sm"
      />
    );
  }
  return <IconGlyph icon={Users} />;
}
