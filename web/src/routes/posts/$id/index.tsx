import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { PostDetail } from "@/components/PostDetail";
import { Button } from "@/components/ui/button";
import { staticTitle } from "@/lib/title";

export const Route = createFileRoute("/posts/$id/")({
  head: () => staticTitle("Post"),
  component: PostDetailPage,
});

// The full page for a post — a direct load, a shared link, a notification.
// From the feed on a desktop the same content opens as an overlay instead
// (see `PostOverlay`).
function PostDetailPage() {
  const { id } = Route.useParams();
  const router = useRouter();

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
      <PostDetail
        // A new post is a new page: no deleting/state carries over.
        key={id}
        id={id}
        heading="h1"
        backLink={
          <Button asChild variant="ghost" size="sm" className="self-start">
            <Link to="/">
              <ArrowLeft className="size-4" />
              Back to feed
            </Link>
          </Button>
        }
        onDeleted={() => router.navigate({ to: "/" })}
      />
    </main>
  );
}
