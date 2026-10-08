import { createFileRoute, useRouter } from "@tanstack/react-router";
import { LoginPrompt } from "@/components/LoginPrompt";
import { PostForm } from "@/components/PostForm";
import { useSession } from "@/lib/auth";
import { useCreatePost } from "@/lib/createPost";
import { staticTitle } from "@/lib/title";

export const Route = createFileRoute("/posts/new")({
  head: () => staticTitle("New post"),
  component: NewPostPage,
});

function NewPostPage() {
  const session = useSession();
  const router = useRouter();
  const createPost = useCreatePost();

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-xl justify-center px-4 py-10">
        <LoginPrompt
          pageHeading
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
      allowOfflineQueue
      onSubmit={async (values) => {
        // Posted or queued (offline) either way — back to the feed, where a
        // queued post shows as pending.
        await createPost(values);
        await router.navigate({ to: "/" });
      }}
    />
  );
}
