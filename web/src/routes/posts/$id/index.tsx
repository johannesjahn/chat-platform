import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { CommentsSection } from "@/components/CommentsSection";
import { LoginPrompt } from "@/components/LoginPrompt";
import { PostCard, PostCardSkeleton } from "@/components/PostCard";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { errorMessage, isNotFoundError } from "@/lib/errors";
import { postsFeedQueryKey } from "@/lib/posts";
import { useUserSummariesById, userHandle, userLabel } from "@/lib/users";
import { staticTitle, usePageTitle, titleExcerpt } from "@/lib/title";

export const Route = createFileRoute("/posts/$id/")({
  head: () => staticTitle("Post"),
  component: PostDetailPage,
});

function PostDetailPage() {
  const { id } = Route.useParams();
  const postId = Number(id);
  const session = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();

  const {
    data: post,
    isLoading,
    error,
  } = $api.useQuery(
    "get",
    "/posts/{id}",
    { params: { path: { id } } },
    { enabled: !!session },
  );

  const authorById = useUserSummariesById(
    post ? [post.authorId] : [],
    !!session,
  );
  const author = post ? authorById.get(post.authorId) : undefined;
  const authorName = author ? userLabel(author) : undefined;
  // Text posts are titled by their opening words; an image/attachment post
  // (or one whose text is empty) by who posted it.
  const excerpt =
    post && post.contentType === "text" ? titleExcerpt(post.content) : "";
  const heading = excerpt || (authorName ? `Post by ${authorName}` : "Post");
  // Deleted posts are a normal case (stale notification, search result or
  // shared link), so a missing post gets a proper not-found state rather
  // than the raw API error (issue #529).
  const notFound = !!session && isNotFoundError(error);
  usePageTitle(post ? heading : notFound ? "Post not found" : undefined);

  const deletePost = $api.useMutation("delete", "/posts/{id}");
  const confirm = useConfirm();
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    if (
      !(await confirm({
        title: "Delete this post?",
        description:
          "It's removed for everyone, along with its comments and reactions. This can't be undone.",
        confirmLabel: "Delete post",
      }))
    )
      return;
    setIsDeleting(true);
    try {
      await deletePost.mutateAsync({ params: { path: { id } } });
      await queryClient.invalidateQueries({ queryKey: postsFeedQueryKey });
      await router.navigate({ to: "/" });
    } finally {
      setIsDeleting(false);
    }
  }

  if (notFound) {
    return (
      <main className="mx-auto w-full max-w-xl px-4 py-10">
        <Card>
          <CardHeader>
            <CardTitle asChild>
              <h1>Post not found</h1>
            </CardTitle>
            <CardDescription>This post may have been deleted.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button asChild>
              <Link to="/">
                <ArrowLeft className="size-4" />
                Back to feed
              </Link>
            </Button>
          </CardFooter>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
      <h1 className="sr-only">
        {post && authorName ? `Post by ${authorName}` : "Post"}
      </h1>
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link to="/">
          <ArrowLeft className="size-4" />
          Back to feed
        </Link>
      </Button>

      {!session ? (
        <LoginPrompt
          title="Log in to view this post"
          description="Posts are only visible to signed-in users."
        />
      ) : isLoading ? (
        <PostCardSkeleton />
      ) : error || !post ? (
        <p className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error
            ? `Could not load post: ${errorMessage(error)}`
            : // No data and no error: the fetch is paused, offline.
              "You're offline, and this post hasn't been loaded on this device yet."}
        </p>
      ) : (
        <>
          <div className="flex w-full justify-center">
            <PostCard
              post={post}
              authorId={post.authorId}
              authorLabel={
                author ? userLabel(author) : `user #${post.authorId}`
              }
              authorHandle={author ? userHandle(author) : undefined}
              authorAvatarUrl={author?.avatarUrl}
              authorAvatarVariants={author?.avatarVariants}
              canModify={
                session.user.id === post.authorId ||
                session.user.role === "admin"
              }
              onDelete={handleDelete}
              isDeleting={isDeleting}
              fullText
            />
          </div>
          <CommentsSection postId={postId} />
        </>
      )}
    </main>
  );
}
