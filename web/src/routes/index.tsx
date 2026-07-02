import { createFileRoute, Link } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { $api } from "../lib/api";
import { useSession } from "../lib/auth";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const session = useSession();
  // The user list is a protected endpoint — only query it while logged in.
  const {
    data: users,
    isLoading,
    error,
  } = $api.useQuery("get", "/users", {}, { enabled: !!session });

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <Card>
        <CardHeader>
          {session ? (
            <>
              <CardTitle className="text-2xl">
                Welcome back, {session.user.username} 👋
              </CardTitle>
              <CardDescription>Good to see you again.</CardDescription>
            </>
          ) : (
            <>
              <CardTitle className="text-2xl">Chat Platform</CardTitle>
              <CardDescription>
                Log in or create an account to get started.
              </CardDescription>
            </>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {!session && (
            <div className="flex gap-2">
              <Button asChild>
                <Link to="/login">Log in</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/register">Create an account</Link>
              </Button>
            </div>
          )}

          <div>
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Users className="size-4" />
              Registered users {users ? `(${users.length})` : ""}
            </div>

            {!session ? (
              <p className="text-sm text-muted-foreground">
                Log in to see who's registered.
              </p>
            ) : isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : error ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Could not load users: {error.message}
              </p>
            ) : !users || users.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No users yet — be the first to register.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {users.map((user) => (
                  <li
                    key={user.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm"
                  >
                    <span className="font-medium">@{user.username}</span>
                    <span className="text-muted-foreground">#{user.id}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
