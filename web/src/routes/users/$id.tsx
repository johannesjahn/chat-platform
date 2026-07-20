import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { LoginPrompt } from "@/components/LoginPrompt";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";

export const Route = createFileRoute("/users/$id")({
  component: UserProfilePage,
});

function UserProfilePage() {
  const { id } = Route.useParams();
  const session = useSession();
  const queryClient = useQueryClient();
  const router = useRouter();

  const goBack = () => {
    if (router.history.canGoBack()) {
      router.history.back();
    } else {
      router.navigate({ to: "/users" });
    }
  };

  const {
    data: user,
    isLoading,
    error,
  } = $api.useQuery(
    "get",
    "/users/{id}",
    { params: { path: { id } } },
    { enabled: !!session },
  );

  const updateUserRole = $api.useMutation("patch", "/users/{id}/role");
  const [roleError, setRoleError] = useState<string | null>(null);

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-xl justify-center px-4 py-10">
        <LoginPrompt
          title="Log in to view this profile"
          description="User profiles are only visible to signed-in users."
        />
      </main>
    );
  }

  const isSelf = String(session.user.id) === id;
  const canManageRole = session.user.role === "admin" && !isSelf;

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <Button variant="ghost" size="sm" className="mb-4" onClick={goBack}>
        <ArrowLeft className="size-4" />
        Back
      </Button>

      {isLoading ? (
        <Card>
          <CardHeader className="flex flex-row items-center gap-4">
            <Skeleton className="size-20 rounded-full" />
            <Skeleton className="h-5 w-32" />
          </CardHeader>
        </Card>
      ) : error || !user ? (
        <Card>
          <CardHeader>
            <p className="text-lg font-semibold">User not found</p>
            <p className="text-sm text-muted-foreground">
              {error ? errorMessage(error) : "This user may not exist."}
            </p>
          </CardHeader>
        </Card>
      ) : (
        <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
          <CardHeader className="flex flex-row items-center gap-4">
            <Avatar
              name={user.displayName || user.username}
              avatarUrl={user.avatarUrl}
              avatarVariants={user.avatarVariants}
              size="xl"
            />
            <div className="flex flex-col leading-tight">
              <span className="text-xl font-semibold">
                {user.displayName || `@${user.username}`}
              </span>
              {user.displayName && (
                <span className="text-sm text-muted-foreground">
                  @{user.username}
                </span>
              )}
              <span className="text-sm capitalize text-muted-foreground">
                {user.role}
              </span>
            </div>
          </CardHeader>
          {canManageRole && (
            <CardContent className="flex flex-col gap-2 border-t border-border pt-4">
              {roleError && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {roleError}
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-muted-foreground">
                  Admin role
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={updateUserRole.isPending}
                  onClick={async () => {
                    setRoleError(null);
                    try {
                      await updateUserRole.mutateAsync({
                        params: { path: { id } },
                        body: {
                          role: user.role === "admin" ? "user" : "admin",
                        },
                      });
                      await queryClient.invalidateQueries({
                        queryKey: ["get", "/users/{id}"],
                      });
                    } catch (err) {
                      setRoleError(errorMessage(err));
                    }
                  }}
                >
                  {updateUserRole.isPending && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  {user.role === "admin" ? "Revoke admin" : "Make admin"}
                </Button>
              </div>
            </CardContent>
          )}
        </Card>
      )}
    </main>
  );
}
