import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  FileText,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Search as SearchIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { LoginPrompt } from "@/components/LoginPrompt";
import { SearchHighlight } from "@/components/SearchHighlight";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/auth";
import { formatChatTimestamp } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import {
  messageSearchChatName,
  MIN_SEARCH_QUERY_LENGTH,
  useSearchComments,
  useSearchMessages,
  useSearchPosts,
} from "@/lib/search";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { useUserSummariesById, userLabel } from "@/lib/users";

type SearchParams = { q?: string };

export const Route = createFileRoute("/search")({
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    q:
      typeof search.q === "string" && search.q.length > 0
        ? search.q
        : undefined,
  }),
  component: SearchPage,
});

type Tab = "all" | "posts" | "comments" | "messages";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "posts", label: "Posts" },
  { id: "comments", label: "Comments" },
  { id: "messages", label: "Messages" },
];

function SearchPage() {
  const session = useSession();
  const navigate = Route.useNavigate();
  const { q: urlQuery } = Route.useSearch();
  const [input, setInput] = useState(urlQuery ?? "");
  const [tab, setTab] = useState<Tab>("all");

  // Debounce before it drives any request/URL change, so typing doesn't fire a
  // search per keystroke (mirrors the users search page).
  const query = useDebouncedValue(input.trim(), 300);

  // Keep the URL in sync (replace, so typing doesn't spam history) so a search
  // is shareable and survives reload.
  useEffect(() => {
    const next = query.length >= MIN_SEARCH_QUERY_LENGTH ? query : undefined;
    if (next !== urlQuery)
      void navigate({ search: next ? { q: next } : {}, replace: true });
  }, [query, urlQuery, navigate]);

  const ready = query.length >= MIN_SEARCH_QUERY_LENGTH;
  const on = (t: Tab) => !!session && ready && (tab === "all" || tab === t);

  const posts = useSearchPosts(query, on("posts"));
  const comments = useSearchComments(query, on("comments"));
  const messages = useSearchMessages(query, on("messages"));

  const showPosts = tab === "all" || tab === "posts";
  const showComments = tab === "all" || tab === "comments";
  const showMessages = tab === "all" || tab === "messages";

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center gap-2">
        <SearchIcon className="size-5 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">
          <GradientText>Search</GradientText>
        </h1>
      </div>

      {!session ? (
        <LoginPrompt
          title="Log in to search"
          description="Search across posts, comments, and your chat messages."
        />
      ) : (
        <>
          <div className="relative w-full">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Search posts, comments, and messages…"
              className="pl-8"
              autoFocus
              aria-label="Search query"
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {TABS.map((t) => (
              <Button
                key={t.id}
                variant={tab === t.id ? "default" : "ghost"}
                size="sm"
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </Button>
            ))}
          </div>

          {!ready ? (
            <p className="text-sm text-muted-foreground">
              Type at least {MIN_SEARCH_QUERY_LENGTH} characters to search.
            </p>
          ) : (
            <div className="flex flex-col gap-8">
              {showPosts && <PostsSection search={posts} />}
              {showComments && <CommentsSection search={comments} />}
              {showMessages && (
                <MessagesSection
                  currentUserId={session.user.id}
                  search={messages}
                />
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}

// --- shared section chrome --------------------------------------------------

function SectionShell({
  icon: Icon,
  title,
  count,
  isLoading,
  error,
  isEmpty,
  emptyLabel,
  children,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  icon: LucideIcon;
  title: string;
  count?: number;
  isLoading: boolean;
  error: unknown;
  isEmpty: boolean;
  emptyLabel: string;
  children: React.ReactNode;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
          {count !== undefined && count > 0 && (
            <span className="ml-1.5 text-muted-foreground/70">{count}</span>
          )}
        </h2>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Searching…
        </div>
      ) : error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Search failed: {errorMessage(error)}
        </p>
      ) : isEmpty ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <>
          <ul role="list" className="flex flex-col gap-2">
            {children}
          </ul>
          {hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={onLoadMore}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Load more"
              )}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

const rowClass =
  "group flex items-start gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm transition-[transform,border-color] duration-300 ease-out hover:-translate-y-px hover:border-primary/40";

// --- posts ------------------------------------------------------------------

function PostsSection({
  search,
}: {
  search: ReturnType<typeof useSearchPosts>;
}) {
  const results = search.data?.pages.flatMap((p) => p.results) ?? [];
  const authorById = useUserSummariesById(
    results.map((r) => r.post.authorId),
    true,
  );

  return (
    <SectionShell
      icon={FileText}
      title="Posts"
      count={search.data ? results.length : undefined}
      isLoading={search.isLoading}
      error={search.error}
      isEmpty={results.length === 0}
      emptyLabel="No matching posts."
      hasNextPage={!!search.hasNextPage}
      isFetchingNextPage={search.isFetchingNextPage}
      onLoadMore={() => void search.fetchNextPage()}
    >
      {results.map(({ post, snippet }) => {
        const author = authorById.get(post.authorId);
        return (
          <li key={post.id}>
            <Link
              to="/posts/$id"
              params={{ id: String(post.id) }}
              className={rowClass}
            >
              <Avatar
                name={author ? userLabel(author) : `user #${post.authorId}`}
                avatarUrl={author?.avatarUrl}
                avatarVariants={author?.avatarVariants}
                size="sm"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">
                    {author ? userLabel(author) : `user #${post.authorId}`}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatChatTimestamp(post.createdAt)}
                  </span>
                </span>
                <SearchHighlight
                  snippet={snippet}
                  className="line-clamp-3 text-muted-foreground group-hover:text-foreground"
                />
              </span>
            </Link>
          </li>
        );
      })}
    </SectionShell>
  );
}

// --- comments ---------------------------------------------------------------

function CommentsSection({
  search,
}: {
  search: ReturnType<typeof useSearchComments>;
}) {
  const results = search.data?.pages.flatMap((p) => p.results) ?? [];
  const authorById = useUserSummariesById(
    results.map((r) => r.comment.authorId),
    true,
  );

  return (
    <SectionShell
      icon={MessageSquare}
      title="Comments"
      count={search.data ? results.length : undefined}
      isLoading={search.isLoading}
      error={search.error}
      isEmpty={results.length === 0}
      emptyLabel="No matching comments."
      hasNextPage={!!search.hasNextPage}
      isFetchingNextPage={search.isFetchingNextPage}
      onLoadMore={() => void search.fetchNextPage()}
    >
      {results.map(({ comment, snippet }) => {
        const author = authorById.get(comment.authorId);
        return (
          <li key={comment.id}>
            <Link
              to="/posts/$id"
              params={{ id: String(comment.postId) }}
              className={rowClass}
            >
              <Avatar
                name={author ? userLabel(author) : `user #${comment.authorId}`}
                avatarUrl={author?.avatarUrl}
                avatarVariants={author?.avatarVariants}
                size="sm"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">
                    {author ? userLabel(author) : `user #${comment.authorId}`}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatChatTimestamp(comment.createdAt)}
                  </span>
                </span>
                <SearchHighlight
                  snippet={snippet}
                  className="line-clamp-3 text-muted-foreground group-hover:text-foreground"
                />
              </span>
            </Link>
          </li>
        );
      })}
    </SectionShell>
  );
}

// --- messages ---------------------------------------------------------------

function MessagesSection({
  currentUserId,
  search,
}: {
  currentUserId: number;
  search: ReturnType<typeof useSearchMessages>;
}) {
  const results = search.data?.pages.flatMap((p) => p.results) ?? [];
  // Chat context is deduplicated across pages into `chats`; index by id.
  const chatById = new Map(
    (search.data?.pages.flatMap((p) => p.chats) ?? []).map((c) => [c.id, c]),
  );
  const senderById = useUserSummariesById(
    results.map((r) => r.message.senderId),
    true,
  );

  return (
    <SectionShell
      icon={MessagesSquare}
      title="Messages"
      count={search.data ? results.length : undefined}
      isLoading={search.isLoading}
      error={search.error}
      isEmpty={results.length === 0}
      emptyLabel="No matching messages in your chats."
      hasNextPage={!!search.hasNextPage}
      isFetchingNextPage={search.isFetchingNextPage}
      onLoadMore={() => void search.fetchNextPage()}
    >
      {results.map(({ message, snippet }) => {
        const chat = chatById.get(message.chatId);
        const chatName = chat
          ? messageSearchChatName(chat, currentUserId)
          : "Chat";
        const sender = senderById.get(message.senderId);
        const senderName = sender
          ? userLabel(sender)
          : `user #${message.senderId}`;
        return (
          <li key={message.id}>
            <Link
              to="/chats/$id"
              params={{ id: String(message.chatId) }}
              className={rowClass}
            >
              <Avatar name={chatName} size="sm" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{chatName}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatChatTimestamp(message.createdAt)}
                  </span>
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {senderName}
                </span>
                <SearchHighlight
                  snippet={snippet}
                  className="line-clamp-3 text-muted-foreground group-hover:text-foreground"
                />
              </span>
            </Link>
          </li>
        );
      })}
    </SectionShell>
  );
}
