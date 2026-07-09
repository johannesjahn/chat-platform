import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { LoginPrompt } from "@/components/LoginPrompt";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
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

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <Button asChild variant="ghost" size="sm" className="mb-4">
        <Link to="/users">
          <ArrowLeft className="size-4" />
          Back to users
        </Link>
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
            <Avatar name={user.username} size="xl" />
            <div className="flex flex-col leading-tight">
              <span className="text-xl font-semibold">@{user.username}</span>
              <span className="text-sm capitalize text-muted-foreground">
                {user.role}
              </span>
            </div>
          </CardHeader>
        </Card>
      )}
    </main>
  );
}
