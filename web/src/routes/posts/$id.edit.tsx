import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { LoginPrompt } from "@/components/LoginPrompt";
import { PostForm } from "@/components/PostForm";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { postsFeedQueryKey } from "@/lib/posts";

export const Route = createFileRoute("/posts/$id/edit")({
  component: EditPostPage,
});

function EditPostPage() {
  const { id } = Route.useParams();
  const session = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();

  const {
    data: post,
    isLoading,
    error,
  } = $api.useQuery("get", "/posts/{id}", {
    params: { path: { id } },
  });
  const updatePost = $api.useMutation("put", "/posts/{id}");

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-xl justify-center px-4 py-10">
        <LoginPrompt
          title="Log in to edit this post"
          description="You need an account to edit posts."
        />
      </main>
    );
  }

  if (isLoading) {
    return (
      <main className="mx-auto w-full max-w-xl px-4 py-10">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (error || !post) {
    return (
      <main className="mx-auto w-full max-w-xl px-4 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Post not found</CardTitle>
            <CardDescription>This post may have been deleted.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  // Enforced for real by the backend (403 Forbidden) — this is UX only, so a
  // non-author/non-admin never even sees an edit form they can't submit.
  const canEdit =
    session.user.id === post.authorId || session.user.role === "admin";
  if (!canEdit) {
    return (
      <main className="mx-auto w-full max-w-xl px-4 py-10">
        <Card>
          <CardHeader>
            <CardTitle>You can&apos;t edit this post</CardTitle>
            <CardDescription>
              Only the author or an admin can edit this post.
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <PostForm
      title="Edit post"
      description="Update your post's content."
      submitLabel="Save changes"
      initialContentType={post.contentType}
      initialContent={post.content}
      onSubmit={async ({ contentType, content }) => {
        await updatePost.mutateAsync({
          params: { path: { id } },
          body: { contentType, content },
        });
        await queryClient.invalidateQueries({ queryKey: postsFeedQueryKey });
        await router.navigate({ to: "/posts" });
      }}
    />
  );
}
