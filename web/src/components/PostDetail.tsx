import { type ReactNode, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CommentsSection } from "@/components/CommentsSection";
import { LoginPrompt } from "@/components/LoginPrompt";
import { PostCard, PostCardSkeleton } from "@/components/PostCard";
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
import { usePageTitle, titleExcerpt } from "@/lib/title";

// A post's full view — the whole text, its reactions and its comment thread
// — shared by the `/posts/$id` page and the feed's desktop overlay (issue
// #561), the way `ChatConversation` is shared by the chat page and the docked
// windows. The caller supplies the frame around it: `heading` is the
// (visually hidden) title element, `backLink` sits above the post and in the
// not-found card, and `onDeleted` runs once the post is gone.
export function PostDetail({
  id,
  heading: Heading,
  headingId,
  backLink,
  onDeleted,
}: {
  id: string;
  heading: "h1" | "h2";
  headingId?: string;
  backLink?: ReactNode;
  onDeleted: () => Promise<unknown> | void;
}) {
  const postId = Number(id);
  const session = useSession();
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
  const title = excerpt || (authorName ? `Post by ${authorName}` : "Post");
  // Deleted posts are a normal case (stale notification, search result or
  // shared link), so a missing post gets a proper not-found state rather
  // than the raw API error (issue #529).
  const notFound = !!session && isNotFoundError(error);
  usePageTitle(post ? title : notFound ? "Post not found" : undefined);

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
      await onDeleted();
    } finally {
      setIsDeleting(false);
    }
  }

  if (notFound) {
    return (
      <Card>
        <CardHeader>
          <CardTitle asChild>
            <Heading id={headingId}>Post not found</Heading>
          </CardTitle>
          <CardDescription>This post may have been deleted.</CardDescription>
        </CardHeader>
        {backLink && <CardFooter>{backLink}</CardFooter>}
      </Card>
    );
  }

  return (
    <>
      <Heading id={headingId} className="sr-only">
        {post && authorName ? `Post by ${authorName}` : "Post"}
      </Heading>
      {backLink}

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
    </>
  );
}
