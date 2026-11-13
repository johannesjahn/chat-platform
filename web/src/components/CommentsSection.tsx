import { useState } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { ProfileHoverCard } from "@/components/ProfileHoverCard";
import { MentionText } from "@/components/MentionText";
import { MentionTextarea } from "@/components/MentionTextarea";
import { ReactionPicker } from "@/components/ReactionPicker";
import { RelativeTime } from "@/components/RelativeTime";
import { Button } from "@/components/ui/button";
import { Collapse, DisclosureChevron } from "@/components/ui/collapse";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import {
  addCreatedComment,
  type Comment,
  invalidatePostComments,
  MAX_COMMENT_CONTENT_LENGTH,
  useComment,
  useComments,
  useReplies,
} from "@/lib/comments";
import { errorMessage, isNotFoundError } from "@/lib/errors";
import { ownCommentScope, ownWrites } from "@/lib/ownWrites";
import { usePostCommentsSubscription } from "@/lib/postRooms";
import type { ReactionEmoji } from "@/lib/reactions";
import { authorLabelOf } from "@/lib/users";
import { cn } from "@/lib/utils";

// Creates a comment or reply as this client's own write (issue #753): the
// response is written straight into the cache, and its realtime echo — which
// can arrive before the response does — is dropped instead of refetching the
// thread and the post (see ownWrites.ts).
async function createOwnComment(
  queryClient: QueryClient,
  postId: number,
  create: () => Promise<Comment>,
): Promise<void> {
  const settle = ownWrites.begin(ownCommentScope(postId));
  let createdId: number | null = null;
  try {
    const created = await create();
    createdId = created.id;
    addCreatedComment(queryClient, created);
  } finally {
    settle(createdId);
  }
}

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
      <MentionTextarea
        value={value}
        autoFocus={autoFocus}
        onValueChange={setValue}
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

function CommentItem({
  comment,
  postId,
  isReply = false,
  highlighted = false,
  hideReplies = false,
}: {
  comment: Comment;
  postId: number;
  isReply?: boolean;
  // The comment a notification points at (see `CommentThreadPreview`).
  highlighted?: boolean;
  // Leaves out the replies toggle — for a parent shown above just the one
  // reply being previewed.
  hideReplies?: boolean;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  // The embedded author (issue #750) — no `GET /users/:id` per comment.
  const author = comment.author;
  const {
    label: authorLabel,
    handle: authorHandle,
    avatarName: authorName,
  } = authorLabelOf(author, comment.authorId);
  const canModify =
    !!session &&
    (session.user.id === comment.authorId || session.user.role === "admin");

  const [showReplies, setShowReplies] = useState(false);
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);

  const addReaction = $api.useMutation("post", "/comments/{id}/reactions");
  const removeReaction = $api.useMutation("delete", "/comments/{id}/reactions");
  const createReply = $api.useMutation("post", "/comments/{id}/replies");
  const updateComment = $api.useMutation("patch", "/comments/{id}");
  const deleteComment = $api.useMutation("delete", "/comments/{id}");
  const confirm = useConfirm();

  // Only this post's comment queries — not every open section's (#753).
  const invalidateComments = () => invalidatePostComments(queryClient, postId);

  // The toggle only renders while there are replies, so the panel must close
  // with it when they drop to zero (deleted here or by someone else) — or it
  // would sit open and empty with nothing left to close it (issue #544).
  const repliesOpen =
    showReplies && !isReply && !hideReplies && comment.replyCount > 0;
  const replies = useReplies(comment.id, repliesOpen);
  const replyRows = replies.data?.pages.flatMap((p) => p.comments) ?? [];

  const reactionPending = addReaction.isPending || removeReaction.isPending;
  const [reactionError, setReactionError] = useState<string | null>(null);
  const toggleReaction = async (emoji: string) => {
    const mine = comment.reactions.find((r) => r.emoji === emoji)?.reactedByMe;
    const mutation = mine ? removeReaction : addReaction;
    setReactionError(null);
    try {
      await mutation.mutateAsync({
        params: { path: { id: String(comment.id) } },
        body: { emoji: emoji as ReactionEmoji },
      });
      await invalidateComments();
    } catch (err) {
      setReactionError(errorMessage(err));
    }
  };

  return (
    <div
      className={cn("flex gap-3", isReply && "ml-9")}
      data-testid="comment"
      data-comment-id={comment.id}
    >
      <ProfileHoverCard userId={comment.authorId}>
        <Link
          to="/users/$id"
          params={{ id: String(comment.authorId) }}
          className="mt-0.5 shrink-0"
          // A mouse shortcut to the name link beside it, which is the one
          // keyboard and screen-reader users get; the avatar alone has no
          // text to name a link by.
          tabIndex={-1}
          aria-hidden="true"
        >
          <Avatar
            name={authorName}
            avatarUrl={author?.avatarUrl}
            avatarVariants={author?.avatarVariants}
            className="size-7 text-xs"
          />
        </Link>
      </ProfileHoverCard>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div
          className={cn(
            "rounded-2xl bg-muted/60 px-3 py-2",
            highlighted && "bg-primary/10 ring-1 ring-primary/50",
          )}
        >
          {/* Wraps, and the name breaks, so a long name pushes the time onto
              the next line instead of out of the bubble. */}
          <div className="flex flex-wrap items-baseline gap-x-2">
            <ProfileHoverCard userId={comment.authorId}>
              <Link
                to="/users/$id"
                params={{ id: String(comment.authorId) }}
                className="min-w-0 text-sm font-medium wrap-anywhere hover:underline"
              >
                {authorLabel}
                {authorHandle && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    {authorHandle}
                  </span>
                )}
              </Link>
            </ProfileHoverCard>
            <span className="text-xs text-muted-foreground">
              <RelativeTime value={comment.createdAt} />
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
              <MentionText text={comment.content} />
            </p>
          )}
        </div>

        {reactionError && (
          <p className="pl-1 text-xs text-destructive">{reactionError}</p>
        )}
        {/* On a phone, Edit and Delete drop to icon-only (their labels stay
            for screen readers) so an own comment's controls fit on one line
            instead of wrapping Delete onto a row of its own (issue #530). */}
        <div className="flex flex-wrap items-center gap-1 pl-1">
          <ReactionPicker
            reactions={comment.reactions}
            pending={reactionPending}
            onToggle={toggleReaction}
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
                <span className="sr-only sm:not-sr-only">Edit</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={deleteComment.isPending}
                className="h-8 gap-1.5 px-2 text-muted-foreground hover:text-destructive"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Delete this comment?",
                    description:
                      "It's removed from the post for everyone. This can't be undone.",
                    confirmLabel: "Delete comment",
                  });
                  if (!ok) return;
                  await deleteComment.mutateAsync({
                    params: { path: { id: String(comment.id) } },
                  });
                  await invalidateComments();
                }}
              >
                <Trash2 className="size-3.5" />
                <span className="sr-only sm:not-sr-only">Delete</span>
              </Button>
            </>
          )}
        </div>

        {!isReply && (
          <Collapse open={replying}>
            <div className="mt-1">
              <CommentComposer
                placeholder={`Reply to ${authorLabel}…`}
                submitLabel="Reply"
                autoFocus
                onSubmit={async (content) => {
                  await createOwnComment(queryClient, postId, () =>
                    createReply.mutateAsync({
                      params: { path: { id: String(comment.id) } },
                      body: { content },
                    }),
                  );
                  setReplying(false);
                  setShowReplies(true);
                }}
              />
            </div>
          </Collapse>
        )}

        {/* Existing replies used to stay hidden until the viewer opened the
            reply composer (issue #479) — the count makes them discoverable,
            and expanding them no longer opens a composer. */}
        {!isReply && !hideReplies && comment.replyCount > 0 && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-1 h-auto w-fit p-0 pl-1 text-xs"
            aria-expanded={showReplies}
            onClick={() => setShowReplies((prev) => !prev)}
          >
            {showReplies
              ? "Hide replies"
              : `View ${comment.replyCount} ${
                  comment.replyCount === 1 ? "reply" : "replies"
                }`}
            <DisclosureChevron open={showReplies} className="size-3.5" />
          </Button>
        )}

        {!isReply && (
          <Collapse open={repliesOpen}>
            <div className="mt-2 flex flex-col gap-3">
              {replyRows.map((reply) => (
                <CommentItem
                  key={reply.id}
                  comment={reply}
                  postId={postId}
                  isReply
                />
              ))}
              {replies.hasNextPage && (
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
          </Collapse>
        )}
      </div>
    </div>
  );
}

// One comment in its thread, highlighted: a reply under its parent (just the
// two, so it never hides behind the parent's reply pagination), a top-level
// comment on its own. The notifications page's `xl` preview pane (issue #564)
// shows it under the post.
export function CommentThreadPreview({
  postId,
  commentId,
}: {
  postId: number;
  commentId: number;
}) {
  usePostCommentsSubscription(postId, true);
  const target = useComment(commentId, true);
  const parentId = target.data?.parentCommentId ?? null;
  const parent = useComment(parentId ?? 0, parentId !== null);

  if (target.isLoading || (parentId !== null && parent.isLoading)) {
    return (
      <div className="flex justify-center py-2">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!target.data) {
    return (
      <p className="text-sm text-muted-foreground">
        {isNotFoundError(target.error)
          ? "This comment has been deleted."
          : `Could not load the comment: ${errorMessage(target.error)}`}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {parent.data && (
        <CommentItem comment={parent.data} postId={postId} hideReplies />
      )}
      <CommentItem
        comment={target.data}
        postId={postId}
        isReply={parentId !== null}
        highlighted
      />
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
          await createOwnComment(queryClient, postId, () =>
            createComment.mutateAsync({
              params: { path: { id: String(postId) } },
              body: { content },
            }),
          );
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
