import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Heart, Loader2, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import {
  type Comment,
  commentRepliesQueryKey,
  commentsQueryKeyRoot,
  MAX_COMMENT_CONTENT_LENGTH,
  postCommentsQueryKey,
  useComments,
  useReplies,
} from "@/lib/comments";
import { errorMessage } from "@/lib/errors";
import { usePostCommentsSubscription } from "@/lib/postRooms";
import { useUserSummariesById, userAvatarName, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";

// A small controlled composer used both for new comments/replies and for
// editing an existing one. Clears itself on a successful submit unless it's an
// edit (which keeps the buffer so a failed save isn't lost).
function CommentComposer({
  placeholder,
  submitLabel,
  initialValue = "",
  autoFocus = false,
  onSubmit,
}: {
  placeholder: string;
  submitLabel: string;
  initialValue?: string;
  autoFocus?: boolean;
  onSubmit: (content: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();
  const overLimit = trimmed.length > MAX_COMMENT_CONTENT_LENGTH;
  const canSubmit = trimmed.length > 0 && !overLimit && !pending;

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!canSubmit) return;
        setError(null);
        setPending(true);
        try {
          await onSubmit(trimmed);
          setValue("");
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setPending(false);
        }
      }}
    >
      <Textarea
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        rows={2}
        aria-invalid={overLimit}
        className="min-h-0 resize-none"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        {overLimit && (
          <span className="mr-auto text-xs text-destructive">
            {trimmed.length}/{MAX_COMMENT_CONTENT_LENGTH}
          </span>
        )}
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

// The like/unlike toggle shared by posts and comments — a heart plus count.
// Kept generic over the two `$api` mutation calls (post vs comment) so both
// look and behave identically.
export function LikeToggle({
  liked,
  likeCount,
  pending,
  onToggle,
}: {
  liked: boolean;
  likeCount: number;
  pending: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onToggle}
      disabled={pending}
      aria-pressed={liked}
      aria-label={liked ? "Unlike" : "Like"}
      className={cn(
        "h-8 gap-1.5 px-2 text-muted-foreground hover:text-rose-500",
        liked && "text-rose-500",
      )}
    >
      <Heart className={cn("size-4", liked && "fill-current")} />
      <span className="tabular-nums">{likeCount}</span>
    </Button>
  );
}

function CommentItem({
  comment,
  postId,
  isReply = false,
}: {
  comment: Comment;
  postId: number;
  isReply?: boolean;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const authorById = useUserSummariesById([comment.authorId], true);
  const author = authorById.get(comment.authorId);
  const authorName = author
    ? userAvatarName(author)
    : `user #${comment.authorId}`;
  const authorLabel = author ? userLabel(author) : `user #${comment.authorId}`;
  const canModify =
    !!session &&
    (session.user.id === comment.authorId || session.user.role === "admin");

  const [showReplies, setShowReplies] = useState(false);
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);

  const likeComment = $api.useMutation("post", "/comments/{id}/likes");
  const unlikeComment = $api.useMutation("delete", "/comments/{id}/likes");
  const createReply = $api.useMutation("post", "/comments/{id}/replies");
  const updateComment = $api.useMutation("patch", "/comments/{id}");
  const deleteComment = $api.useMutation("delete", "/comments/{id}");

  const invalidateComments = () =>
    queryClient.invalidateQueries({ queryKey: commentsQueryKeyRoot });

  const replies = useReplies(comment.id, showReplies && !isReply);
  const replyRows = replies.data?.pages.flatMap((p) => p.comments) ?? [];

  const likePending = likeComment.isPending || unlikeComment.isPending;
  const toggleLike = async () => {
    const mutation = comment.likedByMe ? unlikeComment : likeComment;
    await mutation.mutateAsync({
      params: { path: { id: String(comment.id) } },
    });
    await invalidateComments();
  };

  return (
    <div className={cn("flex gap-3", isReply && "ml-9")}>
      <Link
        to="/users/$id"
        params={{ id: String(comment.authorId) }}
        className="mt-0.5 shrink-0"
      >
        <Avatar name={authorName} className="size-7 text-xs" />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="rounded-2xl bg-muted/60 px-3 py-2">
          <div className="flex items-baseline gap-2">
            <Link
              to="/users/$id"
              params={{ id: String(comment.authorId) }}
              className="text-sm font-medium hover:underline"
            >
              {authorLabel}
            </Link>
            <span className="text-xs text-muted-foreground">
              {new Date(comment.createdAt).toLocaleString()}
              {comment.updatedAt !== comment.createdAt && " · edited"}
            </span>
          </div>
          {editing ? (
            <div className="mt-2">
              <CommentComposer
                initialValue={comment.content}
                placeholder="Edit your comment…"
                submitLabel="Save"
                autoFocus
                onSubmit={async (content) => {
                  await updateComment.mutateAsync({
                    params: { path: { id: String(comment.id) } },
                    body: { content },
                  });
                  await invalidateComments();
                  setEditing(false);
                }}
              />
            </div>
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {comment.content}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1 pl-1">
          <LikeToggle
            liked={comment.likedByMe}
            likeCount={comment.likeCount}
            pending={likePending}
            onToggle={toggleLike}
          />
          {!isReply && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2 text-muted-foreground"
              onClick={() => {
                setReplying((prev) => !prev);
                setShowReplies(true);
              }}
            >
              <MessageSquare className="size-4" />
              Reply
            </Button>
          )}
          {canModify && !editing && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2 text-muted-foreground"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-3.5" />
                Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={deleteComment.isPending}
                className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-destructive"
                onClick={async () => {
                  if (!window.confirm("Delete this comment?")) return;
                  await deleteComment.mutateAsync({
                    params: { path: { id: String(comment.id) } },
                  });
                  await invalidateComments();
                }}
              >
                <Trash2 className="size-3.5" />
                Delete
              </Button>
            </>
          )}
        </div>

        {replying && !isReply && (
          <div className="mt-1">
            <CommentComposer
              placeholder={`Reply to ${authorLabel}…`}
              submitLabel="Reply"
              autoFocus
              onSubmit={async (content) => {
                await createReply.mutateAsync({
                  params: { path: { id: String(comment.id) } },
                  body: { content },
                });
                await queryClient.invalidateQueries({
                  queryKey: commentRepliesQueryKey(comment.id),
                });
                setReplying(false);
                setShowReplies(true);
              }}
            />
          </div>
        )}

        {!isReply && (
          <div className="mt-1 flex flex-col gap-3">
            {showReplies &&
              replyRows.map((reply) => (
                <CommentItem
                  key={reply.id}
                  comment={reply}
                  postId={postId}
                  isReply
                />
              ))}
            {showReplies && replies.hasNextPage && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto w-fit p-0 text-xs"
                onClick={() => void replies.fetchNextPage()}
                disabled={replies.isFetchingNextPage}
              >
                Show more replies
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function CommentsSection({ postId }: { postId: number }) {
  const queryClient = useQueryClient();
  // Join this post's realtime room while the section is open so comment/reply
  // and per-comment-like events arrive live (see postRooms.ts).
  usePostCommentsSubscription(postId, true);

  const comments = useComments(postId, true);
  const rows = comments.data?.pages.flatMap((p) => p.comments) ?? [];
  const createComment = $api.useMutation("post", "/posts/{id}/comments");

  return (
    <div className="flex flex-col gap-4 border-t border-border px-6 py-4">
      <CommentComposer
        placeholder="Write a comment…"
        submitLabel="Comment"
        onSubmit={async (content) => {
          await createComment.mutateAsync({
            params: { path: { id: String(postId) } },
            body: { content },
          });
          await queryClient.invalidateQueries({
            queryKey: postCommentsQueryKey(postId),
          });
        }}
      />

      {comments.isLoading ? (
        <div className="flex justify-center py-2">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No comments yet — start the conversation.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.map((comment) => (
            <CommentItem key={comment.id} comment={comment} postId={postId} />
          ))}
          {comments.hasNextPage && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto w-fit p-0 text-xs"
              onClick={() => void comments.fetchNextPage()}
              disabled={comments.isFetchingNextPage}
            >
              Show more comments
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
