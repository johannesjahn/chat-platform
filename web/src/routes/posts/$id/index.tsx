import {
  createFileRoute,
  Link,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { PostDetail } from "@/components/PostDetail";
import { Button } from "@/components/ui/button";
import { $api } from "@/lib/api";
import { backLabel, backOrigin, canGoBackTo } from "@/lib/backOrigin";
import { postCommentsQueryOptions } from "@/lib/comments";
import { queryClient } from "@/lib/query";
import { warmed, warmRoute } from "@/lib/routeLoader";
import { staticTitle } from "@/lib/title";

export const Route = createFileRoute("/posts/$id/")({
  head: () => staticTitle("Post"),
  // The post and the first page of comments (both embed their authors —
  // issue #750), with the same options `PostDetail` and `CommentsSection`
  // read them with.
  loader: ({ params }) =>
    warmRoute(() => {
      const post = $api.queryOptions("get", "/posts/{id}", {
        params: { path: { id: params.id } },
      });
      const comments = postCommentsQueryOptions(Number(params.id));
      return [
        warmed(post.queryKey, queryClient.ensureQueryData(post)),
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
  const location = useLocation();
  // Opened from somewhere in the app (a profile, search, a notification…):
  // go back there, scroll position and all (issue #762). A direct load, a
  // new tab or a shared link has nowhere to go back to, so it links to the
  // feed instead.
  const origin = backOrigin(location);
  const canGoBack = canGoBackTo(router, origin);

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
      <PostDetail
        // A new post is a new page: no deleting/state carries over.
        key={id}
        id={id}
        heading="h1"
        backLink={
          canGoBack ? (
            <Button asChild variant="ghost" size="sm" className="self-start">
              {/* A real link to the origin (so it opens in a new tab like
                  any other), but a plain click steps back through history
                  rather than pushing a new entry. */}
              <a
                href={origin ?? "/"}
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  router.history.back();
                }}
              >
                <ArrowLeft className="size-4" />
                {backLabel(origin)}
              </a>
            </Button>
          ) : (
            <Button asChild variant="ghost" size="sm" className="self-start">
              <Link to="/">
                <ArrowLeft className="size-4" />
                Back to feed
              </Link>
            </Button>
          )
        }
        onDeleted={() => router.navigate({ to: "/" })}
      />
    </main>
  );
}
