import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { PostDetail } from "@/components/PostDetail";
import { Button } from "@/components/ui/button";
import { $api } from "@/lib/api";
import { postCommentsQueryOptions } from "@/lib/comments";
import { queryClient } from "@/lib/query";
import { warmed, warmRoute } from "@/lib/routeLoader";
import { staticTitle } from "@/lib/title";
import { userSummaryQueryOptions } from "@/lib/users";

export const Route = createFileRoute("/posts/$id/")({
  head: () => staticTitle("Post"),
  // The post, its author's name and the first page of comments, with the
  // same options `PostDetail` and `CommentsSection` read them with.
  loader: ({ params }) =>
    warmRoute(() => {
      const post = $api.queryOptions("get", "/posts/{id}", {
        params: { path: { id: params.id } },
      });
      const comments = postCommentsQueryOptions(Number(params.id));
      return [
        warmed(post.queryKey, queryClient.ensureQueryData(post)).then(
          (data) => {
            const author = userSummaryQueryOptions(data.authorId);
            return warmed(author.queryKey, queryClient.ensureQueryData(author));
          },
        ),
        warmed(
          comments.queryKey,
          queryClient.ensureInfiniteQueryData(comments),
        ),
      ];
    }),
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
