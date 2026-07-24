import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { CommentsSection } from "@/components/CommentsSection";
import { LoginPrompt } from "@/components/LoginPrompt";
import { PostCard, PostCardSkeleton } from "@/components/PostCard";
import { Button } from "@/components/ui/button";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { postsFeedQueryKey } from "@/lib/posts";
import { useUserSummariesById, userLabel } from "@/lib/users";

export const Route = createFileRoute("/posts/$id/")({
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

  const deletePost = $api.useMutation("delete", "/posts/{id}");
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    if (!window.confirm("Delete this post? This can't be undone.")) return;
    setIsDeleting(true);
    try {
      await deletePost.mutateAsync({ params: { path: { id } } });
      await queryClient.invalidateQueries({ queryKey: postsFeedQueryKey });
      await router.navigate({ to: "/" });
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
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
            : "Post not found."}
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
              authorAvatarUrl={author?.avatarUrl}
              authorAvatarVariants={author?.avatarVariants}
              canModify={
                session.user.id === post.authorId ||
                session.user.role === "admin"
              }
              onDelete={handleDelete}
              isDeleting={isDeleting}
            />
          </div>
          <CommentsSection postId={postId} />
        </>
      )}
    </main>
  );
}
