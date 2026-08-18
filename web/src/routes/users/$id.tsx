import { useEffect, useRef, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, MessageCircle, Sparkles } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { BlockUserControls } from "@/components/BlockUserControls";
import { DeleteUserButton } from "@/components/DeleteUserButton";
import { EmptyState } from "@/components/EmptyState";
import { LoginPrompt } from "@/components/LoginPrompt";
import { PostCard, PostCardSkeleton } from "@/components/PostCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { UserStatusBadge } from "@/components/UserStatusBadge";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { chatsListQueryKey } from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import {
  postsFeedQueryKey,
  useUserPosts,
  userPostsQueryKey,
} from "@/lib/posts";
import { useUserStatus } from "@/lib/status";
import { userLabel } from "@/lib/users";

export const Route = createFileRoute("/users/$id")({
  component: UserProfilePage,
});

function UserProfilePage() {
  const { id } = Route.useParams();
  const session = useSession();
  const queryClient = useQueryClient();
  const router = useRouter();

  const goBack = () => {
    if (router.history.canGoBack()) {
      router.history.back();
    } else {
      router.navigate({ to: "/users" });
    }
  };

  const {
    data: user,
    isLoading,
    error,
  } = $api.useQuery(
    "get",
    "/users/{id}",
    { params: { path: { id } } },
    { enabled: !!session },
  );

  const updateUserRole = $api.useMutation("patch", "/users/{id}/role");
  const [roleError, setRoleError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [blockError, setBlockError] = useState<string | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const status = useUserStatus(user?.id, user);

  const createDirectChat = $api.useMutation("post", "/chats/direct");
  async function startDirectChat() {
    setMessageError(null);
    try {
      const chat = await createDirectChat.mutateAsync({
        body: { userId: Number(id) },
      });
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      await router.navigate({
        to: "/chats/$id",
        params: { id: String(chat.id) },
      });
    } catch (err) {
      setMessageError(errorMessage(err));
    }
  }

  const {
    data: postsData,
    isLoading: postsLoading,
    error: postsError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useUserPosts(Number(id), !!session && !!user);
  const posts = postsData?.pages.flatMap((page) => page.posts) ?? [];
  const totalPostCount = postsData?.pages[0]?.totalCount ?? 0;

  const deletePost = $api.useMutation("delete", "/posts/{id}");
  const [deletingPostId, setDeletingPostId] = useState<number | null>(null);
  async function handleDeletePost(postId: number) {
    if (!window.confirm("Delete this post? This can't be undone.")) return;
    setDeletingPostId(postId);
    try {
      await deletePost.mutateAsync({
        params: { path: { id: String(postId) } },
      });
      await queryClient.invalidateQueries({ queryKey: postsFeedQueryKey });
      await queryClient.invalidateQueries({
        queryKey: userPostsQueryKey(Number(id)),
      });
    } finally {
      setDeletingPostId(null);
    }
  }

  const postsSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = postsSentinelRef.current;
    if (!node || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-xl justify-center px-4 py-10">
        <LoginPrompt
          title="Log in to view this profile"
          description="User profiles are only visible to signed-in users."
        />
      </main>
    );
  }

  const isSelf = String(session.user.id) === id;
  const canManageRole = session.user.role === "admin" && !isSelf;

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <Button variant="ghost" size="sm" className="mb-4" onClick={goBack}>
        <ArrowLeft className="size-4" />
        Back
      </Button>

      {isLoading ? (
        <Card>
          <CardHeader className="flex flex-row items-center gap-4">
            <Skeleton className="size-20 rounded-full" />
            <Skeleton className="h-5 w-32" />
          </CardHeader>
        </Card>
      ) : error || !user ? (
        <Card>
          <CardHeader>
            <p className="text-lg font-semibold">User not found</p>
            <p className="text-sm text-muted-foreground">
              {error ? errorMessage(error) : "This user may not exist."}
            </p>
          </CardHeader>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          <Card className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
            <CardHeader className="flex flex-row items-center gap-4">
              <Avatar
                name={user.displayName || user.username}
                avatarUrl={user.avatarUrl}
                avatarVariants={user.avatarVariants}
                size="xl"
              />
              <div className="flex flex-1 flex-col leading-tight">
                <span className="text-xl font-semibold">
                  {user.displayName || `@${user.username}`}
                </span>
                {user.displayName && (
                  <span className="text-sm text-muted-foreground">
                    @{user.username}
                  </span>
                )}
                <UserStatusBadge status={status} className="text-sm" />
                <span className="text-sm capitalize text-muted-foreground">
                  {user.role}
                </span>
                {!postsLoading && (
                  <span className="text-sm text-muted-foreground">
                    {totalPostCount} post{totalPostCount === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              {!isSelf && (
                <Button
                  size="sm"
                  disabled={createDirectChat.isPending}
                  onClick={() => void startDirectChat()}
                >
                  {createDirectChat.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <MessageCircle className="size-4" />
                  )}
                  Message
                </Button>
              )}
            </CardHeader>
            {!isSelf && (
              <CardContent className="flex flex-col gap-2 border-t border-border pt-4">
                {messageError && (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {messageError}
                  </p>
                )}
                {blockError && (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {blockError}
                  </p>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">Privacy</span>
                  <BlockUserControls userId={user.id} onError={setBlockError} />
                </div>
              </CardContent>
            )}
            {canManageRole && (
              <CardContent className="flex flex-col gap-2 border-t border-border pt-4">
                {roleError && (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {roleError}
                  </p>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">
                    Admin role
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={updateUserRole.isPending}
                    onClick={async () => {
                      setRoleError(null);
                      try {
                        await updateUserRole.mutateAsync({
                          params: { path: { id } },
                          body: {
                            role: user.role === "admin" ? "user" : "admin",
                          },
                        });
                        await queryClient.invalidateQueries({
                          queryKey: ["get", "/users/{id}"],
                        });
                      } catch (err) {
                        setRoleError(errorMessage(err));
                      }
                    }}
                  >
                    {updateUserRole.isPending && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    {user.role === "admin" ? "Revoke admin" : "Make admin"}
                  </Button>
                </div>
                {deleteError && (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {deleteError}
                  </p>
                )}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">
                    Delete this user
                  </span>
                  <DeleteUserButton
                    userId={user.id}
                    label={user.displayName || `@${user.username}`}
                    variant="full"
                    onDeleted={goBack}
                    onError={setDeleteError}
                  />
                </div>
              </CardContent>
            )}
          </Card>

          <div className="flex flex-col items-center gap-6">
            <h2 className="w-full text-lg font-semibold tracking-tight">
              {isSelf ? "Your posts" : "Recent posts"}
            </h2>

            {postsLoading ? (
              <div className="flex w-full flex-col items-center gap-6">
                {Array.from({ length: 2 }).map((_, i) => (
                  <PostCardSkeleton key={i} />
                ))}
              </div>
            ) : postsError ? (
              <p className="w-full rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                Could not load posts: {errorMessage(postsError)}
              </p>
            ) : posts.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="No posts yet"
                description={
                  isSelf
                    ? "Anything you post will show up here."
                    : "This user hasn't posted anything yet."
                }
              />
            ) : (
              <ul
                role="list"
                className="flex w-full flex-col items-center gap-6"
              >
                {posts.map((post, i) => (
                  <li key={post.id} className="flex w-full justify-center">
                    <PostCard
                      post={post}
                      authorId={user.id}
                      authorLabel={userLabel(user)}
                      authorAvatarUrl={user.avatarUrl}
                      authorAvatarVariants={user.avatarVariants}
                      canModify={
                        session.user.id === post.authorId ||
                        session.user.role === "admin"
                      }
                      onDelete={() => handleDeletePost(post.id)}
                      isDeleting={deletingPostId === post.id}
                      style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}
                    />
                  </li>
                ))}
              </ul>
            )}

            <div ref={postsSentinelRef} className="h-1 w-full" />
            {isFetchingNextPage && (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            )}
            {!hasNextPage && posts.length > 0 && (
              <p className="text-xs text-muted-foreground">No more posts.</p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
