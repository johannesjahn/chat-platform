import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  FileText,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Search as SearchIcon,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { LoginPrompt } from "@/components/LoginPrompt";
import { SearchHighlight } from "@/components/SearchHighlight";
import { GradientText } from "@/components/reactbits/GradientText";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MIN_USER_SEARCH_QUERY_LENGTH } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { formatChatTimestamp } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import {
  messageSearchChatName,
  MIN_FRAGMENT_QUERY_LENGTH,
  MIN_SEARCH_QUERY_LENGTH,
  useSearchAll,
  useSearchComments,
  useSearchMessages,
  useSearchPosts,
  useSearchUsers,
  type CommentSearchResult,
  type MessageSearchChat,
  type MessageSearchResult,
  type PostSearchResult,
  type UserSearchResult,
} from "@/lib/search";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { userAvatarName, userLabel } from "@/lib/users";

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

type Tab = "all" | "users" | "posts" | "comments" | "messages";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "users", label: "People" },
  { id: "posts", label: "Posts" },
  { id: "comments", label: "Comments" },
  { id: "messages", label: "Messages" },
];

// Short enough that results feel like they're keeping up with typing, long
// enough that a fast typist doesn't fire a request per character. The unified
// endpoint answers the whole page in one round trip, and React Query keeps the
// previous results on screen while the next ones land, so this can sit well
// below the 300ms the old page used.
const SEARCH_DEBOUNCE_MS = 180;

function SearchPage() {
  const session = useSession();
  const navigate = Route.useNavigate();
  const { q: urlQuery } = Route.useSearch();
  const [input, setInput] = useState(urlQuery ?? "");
  const [tab, setTab] = useState<Tab>("all");

  const query = useDebouncedValue(input.trim(), SEARCH_DEBOUNCE_MS);

  // Keep the URL in sync (replace, so typing doesn't spam history) so a search
  // is shareable and survives reload.
  useEffect(() => {
    const next = query.length >= MIN_SEARCH_QUERY_LENGTH ? query : undefined;
    if (next !== urlQuery)
      void navigate({ search: next ? { q: next } : {}, replace: true });
  }, [query, urlQuery, navigate]);

  const ready = !!session && query.length >= MIN_SEARCH_QUERY_LENGTH;

  // The "All" tab is a single request covering every section; a section's own
  // tab switches to that section's paginated endpoint. Only the visible one is
  // enabled, so switching tabs never leaves four searches in flight.
  const all = useSearchAll(query, ready && tab === "all");
  const users = useSearchUsers(query, ready && tab === "users");
  const posts = useSearchPosts(query, ready && tab === "posts");
  const comments = useSearchComments(query, ready && tab === "comments");
  const messages = useSearchMessages(query, ready && tab === "messages");

  const currentUserId = session?.user.id ?? 0;
  // The people section keeps the user directory's own narrowness floor (issue
  // #48) — say so rather than showing an unexplained empty section.
  const peopleEmptyLabel =
    session?.user.role !== "admin" &&
    query.length < MIN_USER_SEARCH_QUERY_LENGTH
      ? `Type at least ${MIN_USER_SEARCH_QUERY_LENGTH} characters to search people.`
      : "No matching people.";
  // While a new query is in flight the previous results stay rendered (see
  // `keepPreviousData` in lib/search.ts) — dimmed, so it's clear they're about
  // to be replaced rather than looking frozen.
  const stale = all.isFetching && !all.isLoading;

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
          description="Search across people, posts, comments and your chat messages."
        />
      ) : (
        <>
          <div className="relative w-full">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Search people, posts, comments and messages…"
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
                className="relative"
              >
                {t.label}
                {/* The active marker grows out of its own centre when the tab
                    is picked, so switching filters animates instead of the
                    underline teleporting between tabs. Keyed on the tab id so
                    it remounts — and replays — on each switch. */}
                {tab === t.id && (
                  <span
                    key={t.id}
                    aria-hidden
                    className="pointer-events-none absolute inset-x-2 -bottom-0.5 h-0.5 rounded-full bg-primary-foreground/70 motion-safe:animate-underline-grow"
                  />
                )}
              </Button>
            ))}
          </div>

          {!ready ? (
            <p className="text-sm text-muted-foreground">
              Type at least {MIN_SEARCH_QUERY_LENGTH} characters to search.
              Matches happen anywhere inside a word from{" "}
              {MIN_FRAGMENT_QUERY_LENGTH} characters up.
            </p>
          ) : tab === "all" ? (
            <div
              className={`flex flex-col gap-8 transition-opacity duration-200 ${
                stale ? "opacity-60" : "opacity-100"
              }`}
            >
              <Section
                icon={Users}
                title="People"
                isLoading={all.isLoading}
                error={all.error}
                count={all.data?.users.results.length}
                emptyLabel={peopleEmptyLabel}
                onSeeAll={
                  all.data?.users.nextCursor ? () => setTab("users") : undefined
                }
              >
                {all.data?.users.results.map((r) => (
                  <UserRow key={r.user.id} result={r} />
                ))}
              </Section>

              <Section
                icon={FileText}
                title="Posts"
                isLoading={all.isLoading}
                error={all.error}
                count={all.data?.posts.results.length}
                emptyLabel="No matching posts."
                onSeeAll={
                  all.data?.posts.nextCursor ? () => setTab("posts") : undefined
                }
              >
                {all.data?.posts.results.map((r) => (
                  <PostRow key={r.id} result={r} />
                ))}
              </Section>

              <Section
                icon={MessageSquare}
                title="Comments & replies"
                isLoading={all.isLoading}
                error={all.error}
                count={all.data?.comments.results.length}
                emptyLabel="No matching comments."
                onSeeAll={
                  all.data?.comments.nextCursor
                    ? () => setTab("comments")
                    : undefined
                }
              >
                {all.data?.comments.results.map((r) => (
                  <CommentRow key={r.id} result={r} />
                ))}
              </Section>

              <Section
                icon={MessagesSquare}
                title="Messages"
                isLoading={all.isLoading}
                error={all.error}
                count={all.data?.messages.results.length}
                emptyLabel="No matching messages in your chats."
                onSeeAll={
                  all.data?.messages.nextCursor
                    ? () => setTab("messages")
                    : undefined
                }
              >
                {all.data?.messages.results.map((r) => (
                  <MessageRow
                    key={r.id}
                    result={r}
                    chats={all.data.messages.chats}
                    currentUserId={currentUserId}
                  />
                ))}
              </Section>
            </div>
          ) : tab === "users" ? (
            <PaginatedSection
              icon={Users}
              title="People"
              search={users}
              emptyLabel={peopleEmptyLabel}
              rows={(page) =>
                page.results.map((r) => <UserRow key={r.user.id} result={r} />)
              }
            />
          ) : tab === "posts" ? (
            <PaginatedSection
              icon={FileText}
              title="Posts"
              search={posts}
              emptyLabel="No matching posts."
              rows={(page) =>
                page.results.map((r) => <PostRow key={r.id} result={r} />)
              }
            />
          ) : tab === "comments" ? (
            <PaginatedSection
              icon={MessageSquare}
              title="Comments & replies"
              search={comments}
              emptyLabel="No matching comments."
              rows={(page) =>
                page.results.map((r) => <CommentRow key={r.id} result={r} />)
              }
            />
          ) : (
            <PaginatedSection
              icon={MessagesSquare}
              title="Messages"
              search={messages}
              emptyLabel="No matching messages in your chats."
              rows={(page) =>
                page.results.map((r) => (
                  <MessageRow
                    key={r.id}
                    result={r}
                    chats={page.chats}
                    currentUserId={currentUserId}
                  />
                ))
              }
            />
          )}
        </>
      )}
    </main>
  );
}

// --- shared section chrome --------------------------------------------------

function SectionHeader({
  icon: Icon,
  title,
  count,
}: {
  icon: LucideIcon;
  title: string;
  count?: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" />
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        {count !== undefined && count > 0 && (
          <span className="ml-1.5 text-muted-foreground/70">{count}</span>
        )}
      </h2>
    </div>
  );
}

// One section of the "All" tab: a preview of that kind of match, with a link
// into its own tab when there's more than the preview holds.
function Section({
  icon,
  title,
  count,
  isLoading,
  error,
  emptyLabel,
  onSeeAll,
  children,
}: {
  icon: LucideIcon;
  title: string;
  count?: number;
  isLoading: boolean;
  error: unknown;
  emptyLabel: string;
  onSeeAll?: () => void;
  children: React.ReactNode;
}) {
  const rows = Array.isArray(children) ? children : [children];
  const isEmpty =
    !isLoading && !error && rows.flat().filter(Boolean).length === 0;

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader icon={icon} title={title} count={count} />
      {isLoading ? (
        <SearchingRow />
      ) : error ? (
        <SearchError error={error} />
      ) : isEmpty ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <>
          <ul role="list" className="flex flex-col gap-2">
            {children}
          </ul>
          {onSeeAll && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={onSeeAll}
            >
              See all {title.toLowerCase()}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

type InfiniteSearch<TPage> = {
  data?: { pages: TPage[] };
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
};

// A single section's own tab: the same rows, paginated.
function PaginatedSection<TPage>({
  icon,
  title,
  search,
  emptyLabel,
  rows,
}: {
  icon: LucideIcon;
  title: string;
  search: InfiniteSearch<TPage>;
  emptyLabel: string;
  rows: (page: TPage) => React.ReactNode;
}) {
  const pages = search.data?.pages ?? [];
  const rendered = pages.map(rows);
  const isEmpty =
    !search.isLoading &&
    !search.error &&
    rendered.flat().filter(Boolean).length === 0;

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader icon={icon} title={title} />
      {search.isLoading ? (
        <SearchingRow />
      ) : search.error ? (
        <SearchError error={search.error} />
      ) : isEmpty ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <>
          <ul role="list" className="flex flex-col gap-2">
            {rendered}
          </ul>
          {search.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => void search.fetchNextPage()}
              disabled={search.isFetchingNextPage}
            >
              {search.isFetchingNextPage ? (
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

function SearchingRow() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Searching…
    </div>
  );
}

function SearchError({ error }: { error: unknown }) {
  return (
    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      Search failed: {errorMessage(error)}
    </p>
  );
}

const rowClass =
  "group flex items-start gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm transition-[transform,border-color] duration-300 ease-out hover:-translate-y-px hover:border-primary/40";

// --- rows -------------------------------------------------------------------

function UserRow({ result: { user, snippet } }: { result: UserSearchResult }) {
  return (
    <li>
      <Link
        to="/users/$id"
        params={{ id: String(user.id) }}
        className={rowClass}
      >
        <Avatar
          name={userAvatarName(user)}
          avatarUrl={user.avatarUrl}
          avatarVariants={user.avatarVariants}
          size="sm"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <SearchHighlight snippet={snippet} className="truncate font-medium" />
          <span className="truncate text-xs text-muted-foreground">
            @{user.username}
            {user.statusEmoji || user.statusText ? (
              <span className="ml-1.5">
                {user.statusEmoji} {user.statusText}
              </span>
            ) : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

// The author/timestamp header every content row shares.
function RowHeading({
  label,
  createdAt,
  detail,
}: {
  label: string;
  createdAt: number;
  detail?: string;
}) {
  return (
    <>
      <span className="flex items-center gap-2">
        <span className="truncate font-medium">{label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatChatTimestamp(createdAt)}
        </span>
      </span>
      {detail && (
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      )}
    </>
  );
}

function PostRow({ result }: { result: PostSearchResult }) {
  const { author, snippet, createdAt } = result;
  return (
    <li>
      <Link
        to="/posts/$id"
        params={{ id: String(result.id) }}
        className={rowClass}
      >
        <Avatar
          name={userAvatarName(author)}
          avatarUrl={author.avatarUrl}
          avatarVariants={author.avatarVariants}
          size="sm"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <RowHeading label={userLabel(author)} createdAt={createdAt} />
          <SearchHighlight
            snippet={snippet}
            className="line-clamp-3 text-muted-foreground group-hover:text-foreground"
          />
        </span>
      </Link>
    </li>
  );
}

function CommentRow({ result }: { result: CommentSearchResult }) {
  const { author, snippet, createdAt, parentCommentId } = result;
  return (
    <li>
      <Link
        to="/posts/$id"
        params={{ id: String(result.postId) }}
        className={rowClass}
      >
        <Avatar
          name={userAvatarName(author)}
          avatarUrl={author.avatarUrl}
          avatarVariants={author.avatarVariants}
          size="sm"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <RowHeading
            label={userLabel(author)}
            createdAt={createdAt}
            // A comment with a parent is a reply — worth saying, since both
            // live in the same section.
            detail={parentCommentId !== null ? "Reply" : undefined}
          />
          <SearchHighlight
            snippet={snippet}
            className="line-clamp-3 text-muted-foreground group-hover:text-foreground"
          />
        </span>
      </Link>
    </li>
  );
}

function MessageRow({
  result,
  chats,
  currentUserId,
}: {
  result: MessageSearchResult;
  chats: readonly MessageSearchChat[];
  currentUserId: number;
}) {
  const { sender, snippet, createdAt, chatId } = result;
  const chat = chats.find((c) => c.id === chatId);
  const chatName = chat ? messageSearchChatName(chat, currentUserId) : "Chat";
  return (
    <li>
      <Link
        to="/chats/$id"
        params={{ id: String(chatId) }}
        className={rowClass}
      >
        <Avatar name={chatName} size="sm" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <RowHeading
            label={chatName}
            createdAt={createdAt}
            detail={userLabel(sender)}
          />
          <SearchHighlight
            snippet={snippet}
            className="line-clamp-3 text-muted-foreground group-hover:text-foreground"
          />
        </span>
      </Link>
    </li>
  );
}
