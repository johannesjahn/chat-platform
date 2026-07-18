import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { LoginPrompt } from "@/components/LoginPrompt";
import { PostForm } from "@/components/PostForm";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { enqueuePost } from "@/lib/offlineQueue";
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
      allowOfflineQueue
      onSubmit={async ({ contentType, content, attachmentId }) => {
        // Offline: queue instead of attempting the request — it would just
        // fail (see lib/offlineQueue.ts, replayed once back online). An
        // attachment post can't be queued this way (PostForm only lets one
        // through while online, since it needs an already-completed
        // upload), so it always falls through to the live request below.
        if (contentType !== "attachment" && !onlineManager.isOnline()) {
          enqueuePost({ contentType, content });
          await router.navigate({ to: "/" });
          return;
        }
        try {
          await createPost.mutateAsync({
            body: { contentType, content, attachmentId },
          });
          await queryClient.invalidateQueries({ queryKey: postsFeedQueryKey });
          await router.navigate({ to: "/" });
        } catch (err) {
          // A network-level failure discovered mid-request (as opposed to a
          // rejected request, which leaves connectivity untouched) — queue
          // it rather than surfacing the failure, same as above (again,
          // not for an attachment post — see the comment above).
          if (contentType !== "attachment" && !onlineManager.isOnline()) {
            enqueuePost({ contentType, content });
            await router.navigate({ to: "/" });
            return;
          }
          throw err;
        }
      }}
    />
  );
}
