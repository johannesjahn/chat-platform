import { createFileRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
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
          <GradientText>Users</GradientText>
        </h1>
        {users && (
          <span className="text-2xl font-semibold tracking-tight text-muted-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
            (<CountUp value={users.length} />)
          </span>
        )}
      </div>

      {!session ? (
        <LoginPrompt
          title="Log in to see who's registered"
          description="The user list is only visible to signed-in users."
        />
      ) : error ? (
        <p className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load users: {errorMessage(error)}
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
        <p className="text-sm text-muted-foreground">
          No users yet — be the first to register.
        </p>
      ) : (
        <Card className="w-full motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
          <CardHeader>
            <CardTitle>Registered users</CardTitle>
            <CardDescription>Everyone with an account so far.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul role="list" className="flex flex-col gap-2">
              {users.map((user, i) => (
                <li
                  key={user.id}
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
                  className="group relative flex items-center justify-between overflow-hidden rounded-lg border border-border bg-background/40 px-3 py-2.5 text-sm transition-[transform,border-color] duration-300 hover:-translate-y-0.5 hover:border-primary/40 motion-safe:fill-mode-both motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500"
                >
                  <Spotlight size={220} />
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
