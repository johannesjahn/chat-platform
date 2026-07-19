import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Loader2,
  MessageSquare,
  Pencil,
  SmilePlus,
  Trash2,
} from "lucide-react";
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
import {
  REACTION_EMOJIS,
  reactionOf,
  type ReactionEmoji,
  type ReactionSummary,
} from "@/lib/reactions";
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

// The emoji reaction picker shared by posts and comments (issue #215,
// widened from the original binary "like" of issue #67). Renders one pill per
// emoji that has at least one reaction (highlighted if the current user is
// one of them), plus a trigger that opens a small popover of the standard
// emoji set for adding a new reaction. Kept generic over the caller's
// `onToggle` (post vs comment mutations) so both look and behave identically.
//
// The popover is rendered through a portal into `document.body`, positioned
// from the trigger button's own `getBoundingClientRect()`, rather than as a
// normal absolutely-positioned child — both call sites (PostCard, and
// CommentsSection itself) live inside a `Card` with `overflow-hidden` (for
// its image/decorative clipping), which would otherwise clip the popover
// invisible whenever the trigger sits near the bottom of the card.
export function ReactionPicker({
  reactions,
  pending,
  onToggle,
}: {
  reactions: ReadonlyArray<ReactionSummary>;
  pending: boolean;
  onToggle: (emoji: string) => void;
}) {
  const [pickerPos, setPickerPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  // A wrapping span rather than a ref on `Button` itself — `Button` (see
  // components/ui/button.tsx) is a plain function component that doesn't
  // declare/forward a `ref` parameter, so it wouldn't receive one.
  const triggerRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerPos) return;
    const close = (event: Event) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setPickerPos(null);
      }
    };
    // Closed on any scroll (capture phase catches scrolling within a nested
    // container, not just the window) rather than tracked/repositioned —
    // this popover is short-lived and simple, so it's not worth wiring up
    // continuous position updates.
    document.addEventListener("pointerdown", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [pickerPos]);

  const active = reactions.filter((r) => r.count > 0);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {active.map((reaction) => (
        <Button
          key={reaction.emoji}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onToggle(reaction.emoji)}
          disabled={pending}
          aria-pressed={reaction.reactedByMe}
          aria-label={`${reaction.reactedByMe ? "Remove" : "Add"} ${reaction.emoji} reaction`}
          className={cn(
            "h-8 gap-1 rounded-full px-2 text-muted-foreground",
            reaction.reactedByMe &&
              "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
          )}
        >
          <span>{reaction.emoji}</span>
          <span className="tabular-nums">{reaction.count}</span>
        </Button>
      ))}
      <span ref={triggerRef} className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            if (pickerPos) {
              setPickerPos(null);
              return;
            }
            const rect = triggerRef.current?.getBoundingClientRect();
            if (rect) setPickerPos({ top: rect.bottom + 4, left: rect.left });
          }}
          disabled={pending}
          aria-expanded={pickerPos !== null}
          aria-label="Add a reaction"
          className="h-8 gap-1.5 px-2 text-muted-foreground"
        >
          <SmilePlus className="size-4" />
        </Button>
      </span>
      {pickerPos &&
        createPortal(
          <div
            ref={popoverRef}
            style={{ top: pickerPos.top, left: pickerPos.left }}
            className="fixed z-50 flex gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
          >
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                disabled={pending}
                aria-label={`React with ${emoji}`}
                className={cn(
                  "flex size-8 items-center justify-center rounded-md text-lg transition-colors hover:bg-muted",
                  reactionOf(reactions, emoji).reactedByMe && "bg-primary/10",
                )}
                onClick={() => {
                  onToggle(emoji);
                  setPickerPos(null);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
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

  const addReaction = $api.useMutation("post", "/comments/{id}/reactions");
  const removeReaction = $api.useMutation("delete", "/comments/{id}/reactions");
  const createReply = $api.useMutation("post", "/comments/{id}/replies");
  const updateComment = $api.useMutation("patch", "/comments/{id}");
  const deleteComment = $api.useMutation("delete", "/comments/{id}");

  const invalidateComments = () =>
    queryClient.invalidateQueries({ queryKey: commentsQueryKeyRoot });

  const replies = useReplies(comment.id, showReplies && !isReply);
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

        {reactionError && (
          <p className="pl-1 text-xs text-destructive">{reactionError}</p>
        )}
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
