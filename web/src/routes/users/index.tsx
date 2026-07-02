import { createFileRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { LoginPrompt } from "@/components/LoginPrompt";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { $api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useSession } from "@/lib/auth";

export const Route = createFileRoute("/users/")({
  component: UsersPage,
});

function UsersPage() {
  const session = useSession();
  // The user list is a protected endpoint — only query it while logged in.
  const {
    data: users,
    isLoading,
    error,
  } = $api.useQuery("get", "/users", {}, { enabled: !!session });

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col items-center gap-6 px-4 py-10">
      <div className="flex w-full items-center gap-2">
        <Users className="size-5 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">
          Users {users ? `(${users.length})` : ""}
        </h1>
      </div>

      {!session ? (
        <LoginPrompt
          title="Log in to see who's registered"
          description="The user list is only visible to signed-in users."
        />
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load users: {errorMessage(error)}
        </p>
      ) : !users || users.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No users yet — be the first to register.
        </p>
      ) : (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Registered users</CardTitle>
            <CardDescription>Everyone with an account so far.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul role="list" className="flex flex-col gap-2">
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
          </CardContent>
        </Card>
      )}
    </main>
  );
}
