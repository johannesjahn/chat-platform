import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Search, Users } from "lucide-react";
import { Avatar } from "@/components/Avatar";
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
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { $api, MIN_USER_SEARCH_QUERY_LENGTH } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useSession } from "@/lib/auth";
import { useDebouncedValue } from "@/lib/useDebouncedValue";

export const Route = createFileRoute("/users/")({
  component: UsersPage,
});

function UsersPage() {
  const session = useSession();
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 300);
  const searchReady = query.length >= MIN_USER_SEARCH_QUERY_LENGTH;

  // The search endpoint is protected — only query it while logged in and
  // once the query is long enough (see issue #48: the full directory isn't
  // exposed unpaginated anymore, only narrow searches).
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
    <main className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-4 py-10">
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
        <div className="relative w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search users…"
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
        <p className="text-sm text-muted-foreground">No matching users.</p>
      ) : (
        <Card className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
          <CardHeader>
            <CardTitle>Matching users</CardTitle>
            <CardDescription>
              People whose username matches “{query}”.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul role="list" className="flex flex-col gap-2">
              {users.map((user, i) => (
                <li key={user.id}>
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
                    className="group relative flex items-center justify-between gap-3 overflow-hidden rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm transition-[transform,border-color] duration-400 ease-out hover:-translate-y-px hover:border-primary/40 motion-safe:fill-mode-both motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500"
                  >
                    <Spotlight size={220} />
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Avatar
                        name={user.displayName || user.username}
                        avatarUrl={user.avatarUrl}
                        avatarVariants={user.avatarVariants}
                        size="sm"
                      />
                      <span className="truncate font-medium">
                        {user.displayName || `@${user.username}`}
                      </span>
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      #{user.id}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
