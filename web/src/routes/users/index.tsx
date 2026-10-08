import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Loader2,
  MessageCircle,
  Search,
  UserSearch,
  Users,
} from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { DeleteUserButton } from "@/components/DeleteUserButton";
import { EmptyState } from "@/components/EmptyState";
import { LoginPrompt } from "@/components/LoginPrompt";
import { CountUp } from "@/components/reactbits/CountUp";
import { GradientText } from "@/components/reactbits/GradientText";
import { Spotlight } from "@/components/reactbits/Spotlight";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { $api, MIN_USER_SEARCH_QUERY_LENGTH } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useSession } from "@/lib/auth";
import { useStartDirectChat } from "@/lib/directChat";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import {
  userAvatarName,
  userHandle,
  userLabel,
  userLabelWithHandle,
} from "@/lib/users";
import { staticTitle } from "@/lib/title";

export const Route = createFileRoute("/users/")({
  head: () => staticTitle("Users"),
  component: UsersPage,
});

function UsersPage() {
  const session = useSession();
  const isAdmin = session?.user.role === "admin";
  const [search, setSearch] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const directChat = useStartDirectChat();
  const [messagingId, setMessagingId] = useState<number | null>(null);
  async function messageUser(userId: number) {
    setMessagingId(userId);
    setDeleteError(null);
    try {
      await directChat.start(userId);
    } catch (err) {
      setDeleteError(errorMessage(err));
    } finally {
      setMessagingId(null);
    }
  }
  const query = useDebouncedValue(search.trim(), 300);
  // Admins can browse the full directory with a short (including empty)
  // query; everyone else still needs a narrow-enough search (see issue #48:
  // the full directory isn't exposed unpaginated to regular users).
  const searchReady = isAdmin || query.length >= MIN_USER_SEARCH_QUERY_LENGTH;

  // The search endpoint is protected — only query it while logged in and
  // once the query is ready.
  const {
    data: users,
    isLoading,
    error,
  } = $api.useQuery(
    "get",
    "/users/search",
    { params: { query: { q: query } } },
    { enabled: !!session && searchReady },
  );

  return (
    // From `lg` the results are a card grid (issue #554) instead of one
    // column, so the page widens with them.
    <main className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-4 py-10 lg:max-w-5xl">
      <div className="flex w-full items-center gap-2">
        <Users className="size-5 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">
          <GradientText>Users</GradientText>
        </h1>
        {searchReady && users && (
          <span className="text-2xl font-semibold tracking-tight text-muted-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
            (<CountUp value={users.length} />)
          </span>
        )}
      </div>

      {!session ? (
        <LoginPrompt
          title="Log in to search for people"
          description="User search is only available to signed-in users."
        />
      ) : (
        <div className="relative w-full lg:max-w-xl lg:self-start">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              isAdmin
                ? "Search users… (or leave blank for everyone)"
                : "Search users…"
            }
            className="pl-8"
            autoFocus
          />
        </div>
      )}

      {!session ? null : !searchReady ? (
        <p className="text-sm text-muted-foreground">
          Type at least {MIN_USER_SEARCH_QUERY_LENGTH} characters to search.
        </p>
      ) : error ? (
        <p className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not search users: {errorMessage(error)}
        </p>
      ) : isLoading ? (
        <Card className="w-full">
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-56" />
          </CardHeader>
          <CardContent>
            <ul role="list" className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between rounded-lg border border-border bg-background/40 px-3 py-2.5"
                >
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-8" />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : !users || users.length === 0 ? (
        <EmptyState
          icon={UserSearch}
          title="No matching users"
          description="Try a different name or check the spelling."
        />
      ) : (
        <Card className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
          <CardHeader>
            <CardTitle>Matching users</CardTitle>
            <CardDescription>
              {query
                ? `People whose username matches "${query}".`
                : "Everyone on the platform."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {deleteError && (
              <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {deleteError}
              </p>
            )}
            <ul
              role="list"
              className="flex flex-col gap-2 lg:grid lg:grid-cols-3 lg:gap-3 xl:grid-cols-4"
            >
              {users.map((user, i) => (
                <li
                  key={user.id}
                  className="group/user relative flex items-center gap-2 lg:block"
                >
                  <Link
                    to="/users/$id"
                    params={{ id: String(user.id) }}
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      e.currentTarget.style.setProperty(
                        "--spot-x",
                        `${e.clientX - rect.left}px`,
                      );
                      e.currentTarget.style.setProperty(
                        "--spot-y",
                        `${e.clientY - rect.top}px`,
                      );
                    }}
                    style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                    className="group relative flex min-w-0 flex-1 items-center justify-between gap-3 overflow-hidden rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm transition-[transform,border-color] duration-400 ease-out hover:-translate-y-px hover:border-primary/40 motion-safe:fill-mode-both motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 lg:h-full lg:flex-col lg:justify-center lg:gap-1 lg:px-4 lg:pb-5 lg:pt-7 lg:text-center"
                  >
                    <Spotlight size={220} />
                    <span className="flex min-w-0 items-center gap-2.5 lg:flex-col lg:gap-2">
                      <Avatar
                        name={userAvatarName(user)}
                        avatarUrl={user.avatarUrl}
                        avatarVariants={user.avatarVariants}
                        size="sm"
                        className="lg:size-14 lg:text-base"
                      />
                      <span className="truncate font-medium">
                        {userLabel(user)}
                      </span>
                    </span>
                    {/* The handle, not the internal id: display names aren't
                        unique, so this is what tells two "Carol"s apart
                        (issue #526). Without a display name the label
                        already is the handle. */}
                    {userHandle(user) && (
                      <span className="max-w-[45%] shrink-0 truncate text-muted-foreground lg:max-w-full">
                        {userHandle(user)}
                      </span>
                    )}
                  </Link>
                  {/* The grid card's quick action: message without leaving
                      the list (a docked window opens). Pointer-revealed,
                      but always reachable by keyboard. */}
                  {user.id !== session?.user.id && (
                    <Button
                      size="icon"
                      variant="secondary"
                      aria-label={`Message ${userLabel(user)}`}
                      title="Message"
                      disabled={messagingId === user.id}
                      onClick={() => void messageUser(user.id)}
                      className="absolute right-2 top-2 hidden size-8 rounded-full opacity-0 shadow transition-opacity focus-visible:opacity-100 group-hover/user:opacity-100 lg:inline-flex"
                    >
                      {messagingId === user.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <MessageCircle className="size-3.5" />
                      )}
                    </Button>
                  )}
                  {isAdmin &&
                    session &&
                    (user.id !== session.user.id ? (
                      <span className="lg:absolute lg:left-2 lg:top-2">
                        <DeleteUserButton
                          userId={user.id}
                          label={userLabelWithHandle(user)}
                          variant="icon"
                          onError={setDeleteError}
                        />
                      </span>
                    ) : (
                      // Holds the delete button's width on the admin's own
                      // row so every row's edges line up.
                      <span aria-hidden className="size-8 shrink-0 lg:hidden" />
                    ))}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
