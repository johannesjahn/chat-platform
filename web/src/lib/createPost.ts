import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { $api } from "./api";
import { enqueuePost } from "./offlineQueue";
import { postsFeedQueryKey, type PostContentType } from "./posts";

export type NewPost = {
  contentType: PostContentType;
  content: string;
  attachmentId?: number;
};

/**
 * Creates a post — or, offline, queues it (see lib/offlineQueue.ts, replayed
 * once back online). Shared by the `/posts/new` page and the feed's inline
 * desktop composer (issue #554), which differ only in where they go after.
 */
export function useCreatePost() {
  const queryClient = useQueryClient();
  const createPost = $api.useMutation("post", "/posts");

  return async function submit({
    contentType,
    content,
    attachmentId,
  }: NewPost) {
    // Offline: queue instead of attempting the request — it would just
    // fail. An attachment post can't be queued this way (the forms only let
    // one through while online, since it needs an already-completed
    // upload), so it always falls through to the live request below.
    if (contentType !== "attachment" && !onlineManager.isOnline()) {
      enqueuePost({ contentType, content });
      return;
    }
    try {
      await createPost.mutateAsync({
        body: { contentType, content, attachmentId },
      });
      await queryClient.invalidateQueries({ queryKey: postsFeedQueryKey });
    } catch (err) {
      // A network-level failure discovered mid-request (as opposed to a
      // rejected request, which leaves connectivity untouched) — queue it
      // rather than surfacing the failure, same as above (again, not for an
      // attachment post — see the comment above).
      if (contentType !== "attachment" && !onlineManager.isOnline()) {
        enqueuePost({ contentType, content });
        return;
      }
      throw err;
    }
  };
}
