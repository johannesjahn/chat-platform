import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Copy,
  Crown,
  Link2,
  Loader2,
  LogOut,
  Pencil,
  Search,
  Shield,
  ShieldOff,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { ChatComposer } from "@/components/ChatComposer";
import { LoginPrompt } from "@/components/LoginPrompt";
import { MessageBubble } from "@/components/MessageBubble";
import { PendingMessageBubble } from "@/components/PendingMessageBubble";
import { PresenceDot } from "@/components/PresenceDot";
import { TypingDots } from "@/components/reactbits/TypingDots";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { $api, MIN_USER_SEARCH_QUERY_LENGTH } from "@/lib/api";
import { useSession } from "@/lib/auth";
import {
  MAX_GROUP_PARTICIPANTS,
  appendSentMessage,
  chatDetailQueryKey,
  chatDisplayName,
  chatsListQueryKey,
  useChatDetail,
  useChatMessages,
} from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import {
  dismissQueuedItem,
  enqueueMessage,
  replayQueue,
  retryQueuedItem,
  useQueuedMessages,
} from "@/lib/offlineQueue";
import { useOnlineStatus } from "@/lib/online";
import { useIsOnline } from "@/lib/presence";
import { clearTyping, useTypingUsers } from "@/lib/typing";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/chats/$id")({
  component: ChatViewPage,
});

function ChatViewPage() {
  const { id } = Route.useParams();
  // Keyed by `id` so every hook (including the message pagination window in
  // `useChatMessages`) starts fresh when navigating between chats, instead
  // of a stale window "leaking" across chats.
  return <ChatView key={id} id={id} />;
}

function ChatView({ id }: { id: string }) {
  const chatId = Number(id);
  const session = useSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const isOnline = useOnlineStatus();

  const {
    data: chat,
    isLoading: chatLoading,
    error: chatError,
  } = useChatDetail(chatId, !!session);
  const {
    data: messagesData,
    isLoading: messagesLoading,
    loadEarlier,
  } = useChatMessages(chatId, !!session);

  // For a direct chat, "online" is a property of the one other participant;
  // group chats don't show a single presence dot. Both hooks must run
  // unconditionally (before the loading/error early returns below), so they
  // tolerate `chat`/`session` still being undefined.
  const otherParticipantId =
    chat?.type === "direct"
      ? chat.participants.find((p) => p.userId !== session?.user.id)?.userId
      : undefined;
  const otherParticipantOnline = useIsOnline(otherParticipantId);
  const typingUsers = useTypingUsers(chatId).filter(
    (t) => t.userId !== session?.user.id,
  );

  const sendMessage = $api.useMutation("post", "/chats/{id}/messages");
  const markRead = $api.useMutation("post", "/chats/{id}/read");
  const updateChat = $api.useMutation("put", "/chats/{id}");
  const addParticipants = $api.useMutation("post", "/chats/{id}/participants");
  const removeParticipant = $api.useMutation(
    "delete",
    "/chats/{id}/participants/{userId}",
  );
  const leaveChat = $api.useMutation("post", "/chats/{id}/leave");
  const deleteChat = $api.useMutation("delete", "/chats/{id}");
  const transferOwnership = $api.useMutation("post", "/chats/{id}/owner");
  const updateMessage = $api.useMutation(
    "put",
    "/chats/{id}/messages/{messageId}",
  );
  const deleteMessage = $api.useMutation(
    "delete",
    "/chats/{id}/messages/{messageId}",
  );
  const updateParticipantRole = $api.useMutation(
    "patch",
    "/chats/{id}/participants/{userId}/role",
  );
  const createInvite = $api.useMutation("post", "/chats/{id}/invites");
  const revokeInvite = $api.useMutation(
    "delete",
    "/chats/{id}/invites/{inviteId}",
  );
  const {
    data: invites,
    isLoading: invitesLoading,
    refetch: refetchInvites,
  } = $api.useQuery(
    "get",
    "/chats/{id}/invites",
    { params: { path: { id: String(chatId) } } },
    { enabled: false },
  );

  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [addingParticipants, setAddingParticipants] = useState(false);
  const [addParticipantsSearch, setAddParticipantsSearch] = useState("");
  const [selectedToAdd, setSelectedToAdd] = useState<number[]>([]);
  const [managingParticipants, setManagingParticipants] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [managingInvites, setManagingInvites] = useState(false);
  const [copiedInviteId, setCopiedInviteId] = useState<number | null>(null);

  const addParticipantsQuery = useDebouncedValue(
    addParticipantsSearch.trim(),
    300,
  );
  const addParticipantsSearchReady =
    addParticipantsQuery.length >= MIN_USER_SEARCH_QUERY_LENGTH;
  const { data: userSearchResults, isLoading: userSearchLoading } =
    $api.useQuery(
      "get",
      "/users/search",
      { params: { query: { q: addParticipantsQuery } } },
      {
        enabled: !!session && addingParticipants && addParticipantsSearchReady,
      },
    );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<number | null>(null);
  const prevScrollHeightRef = useRef<number | null>(null);
  const initializedRef = useRef(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const messages = messagesData?.messages ?? [];
  const pendingMessages = useQueuedMessages(chatId);

  const newestMessage = messages[messages.length - 1];
  const newestMessageId = newestMessage?.id;
  const newestMessageSenderId = newestMessage?.senderId;
  const oldestMessageId = messages[0]?.id;

  // Auto-scroll to the bottom on first load and whenever the newest message
  // changes — a real new message, not just an earlier page loading in.
  useEffect(() => {
    if (newestMessageId == null) return;
    if (lastMessageIdRef.current !== newestMessageId) {
      lastMessageIdRef.current = newestMessageId;
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: initializedRef.current ? "smooth" : "auto",
      });
      initializedRef.current = true;
    }
  }, [newestMessageId]);

  // A message just queued offline appends below the loaded history the same
  // way a real new message would — scroll down to reveal it.
  useEffect(() => {
    if (pendingMessages.length === 0) return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [pendingMessages.length]);

  // A newly-arrived message means its sender is done typing — clear their
  // indicator immediately instead of leaving it up until the TTL in
  // lib/typing.ts lapses on its own, which otherwise left the dots visibly
  // animating below a message that had already been sent.
  useEffect(() => {
    if (newestMessageId == null || newestMessageSenderId == null) return;
    clearTyping(chatId, newestMessageSenderId);
  }, [chatId, newestMessageId, newestMessageSenderId]);

  // Preserve scroll position when older messages are prepended by the
  // infinite-scroll-to-top loader — without this the view would jump to the
  // (now-shifted) top. Uses useLayoutEffect (not useEffect) so the
  // correction lands before the browser paints the prepended content —
  // otherwise the user would see a visible flash at the wrong position.
  useLayoutEffect(() => {
    if (prevScrollHeightRef.current != null && scrollRef.current) {
      const delta =
        scrollRef.current.scrollHeight - prevScrollHeightRef.current;
      scrollRef.current.scrollTop += delta;
      prevScrollHeightRef.current = null;
    }
  }, [oldestMessageId]);

  // Infinite scroll: reaching near the top of the scroll container loads the
  // previous page of older messages, anchored so scroll position is preserved
  // once they're prepended (see the effect above). The spinner clears when
  // the triggering fetch settles, even on failure.
  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (!initializedRef.current || loadingEarlier) return;
    if (!messagesData?.hasEarlier) return;
    const el = e.currentTarget;
    if (el.scrollTop > 120) return;
    prevScrollHeightRef.current = el.scrollHeight;
    setLoadingEarlier(true);
    void loadEarlier().finally(() => setLoadingEarlier(false));
  }

  // Mark everything up to the newest loaded message as read once we know
  // there's something unread — keeps this chat's badge and the nav badge live.
  useEffect(() => {
    if (!session || !chat || chat.unreadCount === 0 || newestMessageId == null)
      return;
    markRead.mutate(
      {
        params: { path: { id: String(chatId) } },
        body: { messageId: newestMessageId },
      },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
          void queryClient.invalidateQueries({
            queryKey: chatDetailQueryKey(chatId),
          });
        },
      },
    );
    // Only re-run when the unread count or the newest message actually
    // changes — `markRead` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.unreadCount, newestMessageId]);

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-2xl justify-center px-4 py-10">
        <LoginPrompt
          title="Log in to view this chat"
          description="Conversations are only visible to signed-in users."
        />
      </main>
    );
  }

  if (chatLoading) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <Card>
          <CardHeader className="flex flex-row items-center gap-3">
            <Skeleton className="size-9 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </CardHeader>
          <CardContent className="flex h-96 flex-col justify-end gap-3">
            <Skeleton className="h-10 w-2/3 self-start rounded-2xl" />
            <Skeleton className="h-10 w-1/2 self-end rounded-2xl" />
            <Skeleton className="h-10 w-3/5 self-start rounded-2xl" />
          </CardContent>
        </Card>
      </main>
    );
  }

  if (!chat) {
    // Deliberately keyed on `!chat`, not `chatError || !chat`: once a chat
    // has been loaded (or restored from the persisted cache — see
    // query.ts), a *background* refetch failing (e.g. a WS-triggered
    // invalidation racing a connectivity drop) must not blank the whole
    // conversation behind this fallback — the stale-but-real `chat` and
    // its messages should just stay on screen instead. This branch is only
    // for when there's truly nothing to show yet.
    //
    // A network-level failure (offline, unreachable server) throws a plain
    // `Error`/`TypeError` from the fetch itself; a real "not found"/"not a
    // participant" response decodes into the API's typed `{ message }` error
    // body instead (see errorMessage.ts's own instanceof check for the same
    // distinction) — so this is the one case that's actually a 403/404, not
    // a connectivity problem, and worth showing the server's own wording for.
    const isApiError = chatError != null && !(chatError instanceof Error);
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <Card>
          <CardHeader>
            <p className="text-lg font-semibold">
              {isApiError ? "Chat not found" : "Can't load this conversation"}
            </p>
            <p className="text-sm text-muted-foreground">
              {isApiError
                ? errorMessage(chatError)
                : isOnline
                  ? "Something went wrong reaching the server. Try again in a moment."
                  : "You're offline, and this conversation hasn't been loaded on this device yet."}
            </p>
          </CardHeader>
        </Card>
      </main>
    );
  }

  const name = chatDisplayName(chat, session.user.id);
  const myRole = chat.participants.find(
    (p) => p.userId === session.user.id,
  )?.role;
  // Mirrors the backend's `requireChatManager` (see ChatsHandler.ts): the
  // chat's owner or admin (per-chat role, issue #220), or a site-wide
  // admin — a site admin only reaches this UI at all once they're a
  // participant, since `getChat` still requires that.
  const canManage =
    myRole === "owner" || myRole === "admin" || session.user.role === "admin";
  // Stricter than `canManage` — mirrors `requireChatOwner`: only the chat's
  // owner (or a site-wide admin) may promote/demote between "admin" and
  // "member", or transfer ownership outright.
  const canManageRoles = myRole === "owner" || session.user.role === "admin";
  // A chat with no creator (its creator's account was deleted — see
  // `Chat.createdBy`) can be claimed by any participant via
  // transferOwnership, so it doesn't stay permanently unmanageable
  // (issue #66).
  const canClaimOwnership = chat.createdBy === null;
  const canAddMore =
    chat.type === "group" && chat.participants.length < MAX_GROUP_PARTICIPANTS;
  const candidatesToAdd = (userSearchResults ?? []).filter(
    (u) => !chat.participants.some((p) => p.userId === u.id),
  );

  async function handleSend(values: {
    contentType: "text" | "image_url" | "attachment";
    content: string;
    attachmentId?: number;
  }) {
    // Offline: queue instead of attempting the request at all — it would
    // just fail (see lib/offlineQueue.ts, replayed once back online). An
    // attachment message can't be queued this way (ChatComposer only lets
    // one through while online, since it needs an already-completed
    // upload), so it always falls through to the live request below.
    if (values.contentType !== "attachment" && !onlineManager.isOnline()) {
      enqueueMessage(chatId, values);
      return;
    }
    try {
      const message = await sendMessage.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: values,
      });
      // Show it immediately from the mutation's own response instead of
      // waiting on a refetch. The server also pushes a `chat_updated` WS event
      // to every participant (including the sender) for this same send, which
      // invalidates the messages/detail/list queries and reconciles anything
      // this optimistic write can't know locally (e.g. read receipts) — so no
      // manual refetch/invalidate is needed here on top of that.
      appendSentMessage(queryClient, chatId, message);
    } catch (err) {
      // A network-level failure (as opposed to a rejected request — a
      // validation error, a 403 — which leaves connectivity untouched) means
      // we just discovered we're offline mid-send. Queue it rather than
      // surfacing the failure, same as the already-offline case above — but
      // not for an attachment message (see the comment above; the queue
      // can't replay one without re-uploading the file).
      if (values.contentType !== "attachment" && !onlineManager.isOnline()) {
        enqueueMessage(chatId, values);
        return;
      }
      throw err;
    }
  }

  async function handleEditMessage(messageId: number, content: string) {
    // No manual refetch here either — same reasoning as handleSend, the
    // `chat_updated` WS push triggered by this edit already invalidates the
    // messages/list queries for every participant, including this client.
    await updateMessage.mutateAsync({
      params: {
        path: { id: String(chatId), messageId: String(messageId) },
      },
      body: { contentType: "text", content },
    });
  }

  async function handleDeleteMessage(messageId: number) {
    await deleteMessage.mutateAsync({
      params: {
        path: { id: String(chatId), messageId: String(messageId) },
      },
    });
  }

  async function handleRenameSubmit() {
    const title = titleDraft.trim();
    if (!title) return;
    setActionError(null);
    try {
      await updateChat.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: { title },
      });
      await queryClient.invalidateQueries({
        queryKey: chatDetailQueryKey(chatId),
      });
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      setRenaming(false);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleAddParticipants() {
    if (selectedToAdd.length === 0) return;
    setActionError(null);
    try {
      await addParticipants.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: { participantIds: selectedToAdd },
      });
      await queryClient.invalidateQueries({
        queryKey: chatDetailQueryKey(chatId),
      });
      setSelectedToAdd([]);
      setAddingParticipants(false);
      setAddParticipantsSearch("");
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleRemoveParticipant(userId: number, label: string) {
    if (!window.confirm(`Remove ${label} from this chat?`)) return;
    setActionError(null);
    try {
      await removeParticipant.mutateAsync({
        params: { path: { id: String(chatId), userId: String(userId) } },
      });
      await queryClient.invalidateQueries({
        queryKey: chatDetailQueryKey(chatId),
      });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleTransferOwnership(userId: number, label: string) {
    if (!window.confirm(`Make ${label} the owner of this chat?`)) return;
    setActionError(null);
    try {
      await transferOwnership.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: { userId },
      });
      await queryClient.invalidateQueries({
        queryKey: chatDetailQueryKey(chatId),
      });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleUpdateParticipantRole(
    userId: number,
    role: "admin" | "member",
  ) {
    setActionError(null);
    try {
      await updateParticipantRole.mutateAsync({
        params: { path: { id: String(chatId), userId: String(userId) } },
        body: { role },
      });
      await queryClient.invalidateQueries({
        queryKey: chatDetailQueryKey(chatId),
      });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleCreateInvite() {
    setActionError(null);
    try {
      await createInvite.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: {},
      });
      await refetchInvites();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleRevokeInvite(inviteId: number) {
    setActionError(null);
    try {
      await revokeInvite.mutateAsync({
        params: { path: { id: String(chatId), inviteId: String(inviteId) } },
      });
      await refetchInvites();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleCopyInviteLink(inviteId: number, code: string) {
    const url = `${window.location.origin}/chats/join/${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedInviteId(inviteId);
      setTimeout(
        () => setCopiedInviteId((prev) => (prev === inviteId ? null : prev)),
        2000,
      );
    } catch {
      setActionError("Couldn't copy the link — copy it manually.");
    }
  }

  async function handleLeave() {
    if (!window.confirm("Leave this chat?")) return;
    setActionError(null);
    try {
      await leaveChat.mutateAsync({
        params: { path: { id: String(chatId) } },
      });
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      await router.navigate({ to: "/chats" });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this chat for everyone? This can't be undone."))
      return;
    setActionError(null);
    try {
      await deleteChat.mutateAsync({
        params: { path: { id: String(chatId) } },
      });
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      await router.navigate({ to: "/chats" });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <Card className="overflow-hidden py-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <CardHeader className="flex flex-row items-center gap-3 border-b border-border py-3">
          <Button
            asChild
            size="icon"
            variant="ghost"
            aria-label="Back to chats"
          >
            <Link to="/chats">
              <ArrowLeft className="size-4" />
            </Link>
          </Button>

          {chat.type === "direct" && otherParticipantId != null ? (
            <Link
              to="/users/$id"
              params={{ id: String(otherParticipantId) }}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <div className="relative shrink-0">
                <Avatar name={name} />
                <PresenceDot
                  online={otherParticipantOnline}
                  className="absolute -bottom-0.5 -right-0.5"
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate font-semibold">{name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {otherParticipantOnline ? "Online" : "Direct message"}
                </span>
              </div>
            </Link>
          ) : (
            <>
              <div className="relative shrink-0">
                <div className="flex size-9 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">
                  <Users className="size-4" />
                </div>
              </div>

              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                {renaming ? (
                  <form
                    className="flex items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleRenameSubmit();
                    }}
                  >
                    <Input
                      autoFocus
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      maxLength={100}
                      className="h-7 py-0"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      type="submit"
                      className="size-7"
                    >
                      <Check className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      type="button"
                      className="size-7"
                      onClick={() => setRenaming(false)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </form>
                ) : (
                  <span className="truncate font-semibold">{name}</span>
                )}
                <span className="truncate text-xs text-muted-foreground">
                  {chat.participants.length} participant
                  {chat.participants.length === 1 ? "" : "s"}
                </span>
              </div>
            </>
          )}

          {chat.type === "group" && canManage && !renaming && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Rename chat"
              onClick={() => {
                setTitleDraft(chat.title ?? "");
                setRenaming(true);
              }}
            >
              <Pencil className="size-4" />
            </Button>
          )}
          {chat.type === "group" && canManage && canAddMore && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Add participants"
              onClick={() => {
                setAddingParticipants((v) => !v);
                setAddParticipantsSearch("");
              }}
            >
              <UserPlus className="size-4" />
            </Button>
          )}
          {chat.type === "group" && canManage && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Manage invite links"
              onClick={() => {
                setManagingInvites((v) => {
                  if (!v) void refetchInvites();
                  return !v;
                });
              }}
            >
              <Link2 className="size-4" />
            </Button>
          )}
          {chat.type === "group" && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Manage participants"
              onClick={() => setManagingParticipants((v) => !v)}
            >
              <Users className="size-4" />
            </Button>
          )}
          {chat.type === "group" && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Leave chat"
              disabled={leaveChat.isPending}
              onClick={() => void handleLeave()}
            >
              <LogOut className="size-4" />
            </Button>
          )}
        </CardHeader>

        {managingParticipants && chat.type === "group" && (
          <div className="flex flex-col gap-2 border-b border-border bg-accent/20 px-4 py-3">
            {actionError && (
              <p className="text-xs text-destructive">{actionError}</p>
            )}
            <ul className="flex flex-col gap-1.5">
              {chat.participants.map((p) => {
                const isOwner = chat.createdBy === p.userId;
                const isSelf = p.userId === session.user.id;
                const label = userLabel(p);
                // A chat-level admin can remove other members/admins but not
                // the owner — mirrors `requireChatManager` plus the
                // owner-removal guard in `removeParticipant` (ChatsHandler.ts).
                const canRemove =
                  canManage &&
                  !isSelf &&
                  (!isOwner ||
                    myRole === "owner" ||
                    session.user.role === "admin");
                return (
                  <li
                    key={p.userId}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-1.5 truncate">
                      {isOwner ? (
                        <Crown className="size-3.5 shrink-0 text-amber-500" />
                      ) : p.role === "admin" ? (
                        <Shield className="size-3.5 shrink-0 text-primary" />
                      ) : null}
                      <span className="truncate">
                        {label}
                        {isSelf ? " (you)" : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {canManageRoles && !isOwner && !isSelf && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-6"
                          aria-label={
                            p.role === "admin"
                              ? `Remove admin from ${label}`
                              : `Make ${label} an admin`
                          }
                          disabled={updateParticipantRole.isPending}
                          onClick={() =>
                            void handleUpdateParticipantRole(
                              p.userId,
                              p.role === "admin" ? "member" : "admin",
                            )
                          }
                        >
                          {p.role === "admin" ? (
                            <ShieldOff className="size-3.5" />
                          ) : (
                            <Shield className="size-3.5" />
                          )}
                        </Button>
                      )}
                      {(canManageRoles || canClaimOwnership) && !isOwner && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          disabled={transferOwnership.isPending}
                          onClick={() =>
                            void handleTransferOwnership(p.userId, label)
                          }
                        >
                          Make owner
                        </Button>
                      )}
                      {canRemove && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-6"
                          aria-label={`Remove ${label}`}
                          disabled={removeParticipant.isPending}
                          onClick={() =>
                            void handleRemoveParticipant(p.userId, label)
                          }
                        >
                          <UserMinus className="size-3.5" />
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            {canManage && (
              <Button
                size="sm"
                variant="destructive"
                className="self-end"
                disabled={deleteChat.isPending}
                onClick={() => void handleDelete()}
              >
                <Trash2 className="size-3.5" />
                Delete chat
              </Button>
            )}
          </div>
        )}

        {managingInvites && chat.type === "group" && canManage && (
          <div className="flex flex-col gap-2 border-b border-border bg-accent/20 px-4 py-3">
            {actionError && (
              <p className="text-xs text-destructive">{actionError}</p>
            )}
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Anyone with a link can join this chat.
              </p>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={createInvite.isPending}
                onClick={() => void handleCreateInvite()}
              >
                {createInvite.isPending && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                New invite link
              </Button>
            </div>
            {invitesLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : (
              (() => {
                const activeInvites = (invites ?? []).filter(
                  (i) => i.revokedAt === null,
                );
                return activeInvites.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No active invite links.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {activeInvites.map((invite) => {
                      const expired =
                        invite.expiresAt !== null &&
                        invite.expiresAt <= Date.now();
                      const usedUp =
                        invite.maxUses !== null &&
                        invite.useCount >= invite.maxUses;
                      return (
                        <li
                          key={invite.id}
                          className="flex items-center justify-between gap-2 text-xs"
                        >
                          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                            {invite.code.slice(0, 10)}…
                            {(expired || usedUp) && (
                              <span className="ml-1 text-destructive">
                                ({expired ? "expired" : "used up"})
                              </span>
                            )}
                            {invite.maxUses !== null &&
                              ` · ${invite.useCount}/${invite.maxUses} used`}
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6"
                              aria-label="Copy invite link"
                              onClick={() =>
                                void handleCopyInviteLink(
                                  invite.id,
                                  invite.code,
                                )
                              }
                            >
                              {copiedInviteId === invite.id ? (
                                <Check className="size-3.5 text-green-600" />
                              ) : (
                                <Copy className="size-3.5" />
                              )}
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6 text-destructive hover:text-destructive"
                              aria-label="Revoke invite link"
                              disabled={revokeInvite.isPending}
                              onClick={() => void handleRevokeInvite(invite.id)}
                            >
                              <X className="size-3.5" />
                            </Button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                );
              })()
            )}
          </div>
        )}

        {addingParticipants && (
          <div className="flex flex-col gap-2 border-b border-border bg-accent/20 px-4 py-3">
            {actionError && (
              <p className="text-xs text-destructive">{actionError}</p>
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={addParticipantsSearch}
                onChange={(e) => setAddParticipantsSearch(e.target.value)}
                placeholder="Search users to add…"
                className="h-8 pl-8 text-xs"
              />
            </div>
            {!addParticipantsSearchReady ? (
              <p className="text-xs text-muted-foreground">
                Type at least {MIN_USER_SEARCH_QUERY_LENGTH} characters to
                search.
              </p>
            ) : userSearchLoading ? (
              <p className="text-xs text-muted-foreground">Searching…</p>
            ) : candidatesToAdd.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No matching users to add.
              </p>
            ) : (
              <>
                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                  {candidatesToAdd.map((u) => {
                    const isSelected = selectedToAdd.includes(u.id);
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() =>
                          setSelectedToAdd((prev) =>
                            isSelected
                              ? prev.filter((id) => id !== u.id)
                              : [...prev, u.id],
                          )
                        }
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs transition-colors duration-200",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background/60 hover:border-primary/40",
                        )}
                      >
                        {userLabel(u)}
                      </button>
                    );
                  })}
                </div>
                <Button
                  size="sm"
                  className="self-end"
                  disabled={
                    selectedToAdd.length === 0 || addParticipants.isPending
                  }
                  onClick={() => void handleAddParticipants()}
                >
                  {addParticipants.isPending && (
                    <Loader2 className="size-3.5 animate-spin" />
                  )}
                  Add {selectedToAdd.length || ""}
                </Button>
              </>
            )}
          </div>
        )}

        <CardContent className="px-0">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            data-testid="chat-scroll"
            className="flex h-[60vh] flex-col gap-2 overflow-y-auto px-4 py-4"
          >
            {loadingEarlier && (
              <div className="flex justify-center py-1">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}

            {messagesLoading ? (
              <div className="flex flex-1 flex-col justify-end gap-3">
                <Skeleton className="h-10 w-2/3 self-start rounded-2xl" />
                <Skeleton className="h-10 w-1/2 self-end rounded-2xl" />
              </div>
            ) : messages.length === 0 && pendingMessages.length === 0 ? (
              <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                No messages yet — say hi 👋
              </p>
            ) : (
              messages.map((message, i) => {
                const isOwn = message.senderId === session.user.id;
                const sender = chat.participants.find(
                  (p) => p.userId === message.senderId,
                );
                return (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    isOwn={isOwn}
                    isRead={message.readByUserIds.length > 0}
                    canModify={isOwn || session.user.role === "admin"}
                    canDeleteOthers={!isOwn && canManage}
                    onEdit={(content) => handleEditMessage(message.id, content)}
                    onDelete={() => handleDeleteMessage(message.id)}
                    senderLabel={
                      chat.type === "group" && sender
                        ? userLabel(sender)
                        : undefined
                    }
                    style={{ animationDelay: `${Math.min(i, 6) * 30}ms` }}
                  />
                );
              })
            )}

            {!messagesLoading &&
              pendingMessages.map((item) => (
                <PendingMessageBubble
                  key={item.clientId}
                  item={item}
                  onRetry={() => {
                    retryQueuedItem(item.clientId);
                    void replayQueue(queryClient);
                  }}
                  onDismiss={() => dismissQueuedItem(item.clientId)}
                />
              ))}

            {typingUsers.length > 0 && (
              <div className="flex w-full justify-start motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-2 motion-safe:duration-300">
                <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-border bg-card px-3.5 py-2.5 text-muted-foreground shadow-sm">
                  <TypingDots />
                  {chat.type === "group" && (
                    <span className="text-xs">
                      {typingUsers.map((t) => userLabel(t)).join(", ")}{" "}
                      {typingUsers.length === 1 ? "is" : "are"} typing…
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </CardContent>

        <ChatComposer chatId={chatId} onSend={handleSend} />
      </Card>
    </main>
  );
}
