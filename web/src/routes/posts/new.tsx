import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { LoginPrompt } from "@/components/LoginPrompt";
import { PostForm } from "@/components/PostForm";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { postsFeedQueryKey } from "@/lib/posts";

export const Route = createFileRoute("/posts/new")({
  component: NewPostPage,
});

function NewPostPage() {
  const session = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const createPost = $api.useMutation("post", "/posts");

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-xl justify-center px-4 py-10">
        <LoginPrompt
          title="Log in to create a post"
          description="You need an account to post."
        />
      </main>
    );
  }

  return (
    <PostForm
      title="New post"
      description="Share a text update or an image with everyone."
      submitLabel="Post"
      onSubmit={async ({ contentType, content }) => {
        await createPost.mutateAsync({ body: { contentType, content } });
        await queryClient.invalidateQueries({ queryKey: postsFeedQueryKey });
        await router.navigate({ to: "/" });
      }}
    />
  );
}
