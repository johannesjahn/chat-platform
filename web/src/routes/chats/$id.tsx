import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Settings2, Users } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { ChatComposer, type ReplyTarget } from "@/components/ChatComposer";
import { DateSeparator } from "@/components/DateSeparator";
import { GroupManagementDialog } from "@/components/GroupManagementDialog";
import { LoginPrompt } from "@/components/LoginPrompt";
import { MessageBubble } from "@/components/MessageBubble";
import { PendingMessageBubble } from "@/components/PendingMessageBubble";
import { PinnedMessagesBar } from "@/components/PinnedMessagesBar";
import { PresenceDot } from "@/components/PresenceDot";
import { TypingDots } from "@/components/reactbits/TypingDots";
import { UserStatusBadge } from "@/components/UserStatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import {
  appendSentMessage,
  chatDetailQueryKey,
  chatDisplayName,
  chatsListQueryKey,
  localDayKey,
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
import { isStatusVisible, useUserStatus } from "@/lib/status";
import { clearTyping, useTypingUsers } from "@/lib/typing";
import { userAvatarName, userLabel } from "@/lib/users";
import { useImmersiveShell } from "@/lib/viewport";

export const Route = createFileRoute("/chats/$id")({
  component: ChatViewPage,
});

// How close to the bottom of the thread still counts as "at the bottom" —
// fractional scroll heights (sub-pixel layout, zoom) mean an exact
// `scrollHeight - scrollTop === clientHeight` comparison almost never lands.
const BOTTOM_EPSILON_PX = 24;

// The conversation's own header, shared with the loading skeleton so the two
// are the same height and opening a chat doesn't shift the thread.
//
// It owns `env(safe-area-inset-top)` below `sm`, where the immersive shell
// hides the site nav (see styles.css) and this becomes the topmost chrome on
// screen — `viewport-fit=cover` lets the page run under the status bar, so
// something has to put a background there or the clock sits on the messages.
// Above `sm` the nav is back and owns the inset again, hence `sm:pt-3`.
const CHAT_HEADER_CLASS =
  "flex shrink-0 flex-row items-center gap-3 border-b border-border pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:pt-3";

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
  const otherParticipant =
    chat?.type === "direct"
      ? chat.participants.find((p) => p.userId !== session?.user.id)
      : undefined;
  const otherParticipantId = otherParticipant?.userId;
  const otherParticipantOnline = useIsOnline(otherParticipantId);
  const otherParticipantStatus = useUserStatus(
    otherParticipantId,
    otherParticipant,
  );
  const typingUsers = useTypingUsers(chatId).filter(
    (t) => t.userId !== session?.user.id,
  );

  const sendMessage = $api.useMutation("post", "/chats/{id}/messages");
  const markRead = $api.useMutation("post", "/chats/{id}/read");
  const updateMessage = $api.useMutation(
    "put",
    "/chats/{id}/messages/{messageId}",
  );
  const deleteMessage = $api.useMutation(
    "delete",
    "/chats/{id}/messages/{messageId}",
  );

  // Take over the whole screen for as long as there's a conversation (or the
  // skeleton standing in for one) to show: the page stops scrolling and, on a
  // phone, the site nav gives its space to the thread. See
  // `useImmersiveShell`. Deliberately *not* on for the logged-out and
  // can't-load branches below — those are ordinary pages, and hiding the nav
  // would leave them with no way out.
  useImmersiveShell(!!session && (chatLoading || chat != null));

  const [managingGroup, setManagingGroup] = useState(false);
  // The message a reply is currently being composed against (issue #217), or
  // null when composing a normal message.
  const [replyingTo, setReplyingTo] = useState<ReplyTarget | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastMessageIdRef = useRef<number | null>(null);
  const prevScrollHeightRef = useRef<number | null>(null);
  const initializedRef = useRef(false);
  // Whether the thread should stay stuck to its bottom edge. Starts true so a
  // chat that hasn't been scrolled yet keeps following the newest message
  // while it's still settling (see the ResizeObserver below).
  const atBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  function scrollToBottom(behavior: ScrollBehavior) {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    atBottomRef.current = true;
    lastScrollTopRef.current = el.scrollTop;
  }

  const messages = messagesData?.messages ?? [];
  const pendingMessages = useQueuedMessages(chatId);

  const myUserId = session?.user.id;
  // The conversation's own markup (and with it `scrollRef`/`contentRef`) only
  // mounts once the chat has loaded — the effects below key off this so they
  // re-run against the real elements rather than the loading skeleton's nulls.
  const chatReady = chat != null;

  const newestMessage = messages[messages.length - 1];
  const newestMessageId = newestMessage?.id;
  const newestMessageSenderId = newestMessage?.senderId;
  const oldestMessageId = messages[0]?.id;

  // Auto-scroll to the bottom on first load and whenever the newest message
  // changes — a real new message, not just an earlier page loading in.
  // `useLayoutEffect`, so the opening jump lands before the browser paints:
  // with `useEffect` the thread was visible at the top for a frame first.
  // A later message only pulls the view down when the user is already at the
  // bottom (or sent it themselves) — otherwise someone reading back through
  // the history would get yanked away from what they're reading.
  useLayoutEffect(() => {
    if (newestMessageId == null) return;
    if (lastMessageIdRef.current === newestMessageId) return;
    lastMessageIdRef.current = newestMessageId;
    const isInitial = !initializedRef.current;
    initializedRef.current = true;
    if (isInitial) {
      scrollToBottom("auto");
    } else if (atBottomRef.current || newestMessageSenderId === myUserId) {
      scrollToBottom("smooth");
    }
  }, [newestMessageId, newestMessageSenderId, myUserId]);

  // Content that grows *after* it was first laid out — an image finishing its
  // load, the composer expanding to a second line, the pinned bar opening —
  // pushes the newest message back out of view again. Re-pin to the bottom
  // whenever the thread or its viewport is resized while the user is already
  // there, so "opens scrolled to the bottom" survives those late reflows.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const observer = new ResizeObserver(() => {
      if (!atBottomRef.current) return;
      scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(scroller);
    observer.observe(content);
    return () => observer.disconnect();
  }, [chatReady]);

  // A message just queued offline appends below the loaded history the same
  // way a real new message would — scroll down to reveal it.
  useEffect(() => {
    if (pendingMessages.length === 0) return;
    scrollToBottom("smooth");
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
    const el = e.currentTarget;
    // Re-evaluated on every scroll (ahead of the guards below) so the
    // auto-scroll and resize handlers know whether to keep following the
    // newest message. Landing at the bottom re-arms it; only scrolling *up*
    // releases it. Deliberately not "released whenever we're not at the
    // bottom": a scroll event is dispatched a frame after the scroll itself,
    // so a jump-to-bottom that raced content still growing underneath it
    // reports a stale gap — and treating that as "the user scrolled away"
    // used to switch the pinning off before it had ever taken effect.
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom <= BOTTOM_EPSILON_PX) {
      atBottomRef.current = true;
    } else if (el.scrollTop < lastScrollTopRef.current) {
      atBottomRef.current = false;
    }
    lastScrollTopRef.current = el.scrollTop;
    if (!initializedRef.current || loadingEarlier) return;
    if (!messagesData?.hasEarlier) return;
    if (el.scrollTop > 120) return;
    prevScrollHeightRef.current = el.scrollHeight;
    setLoadingEarlier(true);
    void loadEarlier().finally(() => setLoadingEarlier(false));
  }

  // Scroll the thread to a pinned message when its row in the pinned bar is
  // clicked, and briefly highlight it. Only works while the message is within
  // the loaded window — a pin can point at a message far up the history that
  // hasn't been paged in — so a miss is a no-op rather than an error.
  function jumpToMessage(messageId: number) {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${messageId}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("bg-primary/10", "rounded-2xl");
    window.setTimeout(() => {
      el.classList.remove("bg-primary/10", "rounded-2xl");
    }, 1500);
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
      <main className="mx-auto flex min-h-0 w-full max-w-2xl grow basis-0 flex-col sm:px-4 sm:py-6">
        <Card className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-none border-x-0 py-0 sm:rounded-xl sm:border-x">
          <CardHeader className={CHAT_HEADER_CLASS}>
            <Skeleton className="size-9 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col justify-end gap-3 px-4 py-4">
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

  async function handleSend(values: {
    contentType: "text" | "image_url" | "attachment";
    content: string;
    attachmentId?: number;
    parentMessageId?: number;
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

  return (
    // `grow basis-0`, not `flex-1`: the root layout's <body> is
    // `min-h-[100dvh]` (a *min*-height, so its height stays indefinite), and
    // a percentage `flex-basis` — which is what `flex-1`'s `flex: 1 1 0%`
    // uses — can't resolve against an indefinite container, so the spec makes
    // it fall back to the item's content size. That let this <main> grow to
    // the full height of the message thread instead of the viewport: the
    // conversation's own scroll container was never shorter than its content,
    // so nothing scrolled inside the chat and the *page* scrolled instead,
    // opening every chat parked at the oldest loaded message. A definite
    // `flex-basis: 0px` resolves fine, so the min-height clamp gives this the
    // leftover viewport height and the thread scrolls within it — which is
    // what issue #321's fill-the-screen layout was after all along.
    <main className="mx-auto flex min-h-0 w-full max-w-2xl grow basis-0 flex-col sm:px-4 sm:py-6">
      <Card className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-none border-x-0 py-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 sm:rounded-xl sm:border-x">
        <CardHeader className={CHAT_HEADER_CLASS}>
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
                <Avatar
                  name={name}
                  avatarUrl={otherParticipant?.avatarUrl}
                  avatarVariants={otherParticipant?.avatarVariants}
                />
                <PresenceDot
                  online={otherParticipantOnline}
                  className="absolute -bottom-0.5 -right-0.5"
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate font-semibold">{name}</span>
                <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                  <span className="shrink-0">
                    {otherParticipantOnline ? "Online" : "Direct message"}
                  </span>
                  {isStatusVisible(otherParticipantStatus) && (
                    <>
                      <span className="shrink-0">·</span>
                      <UserStatusBadge
                        status={otherParticipantStatus}
                        className="min-w-0"
                      />
                    </>
                  )}
                </div>
              </div>
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => setManagingGroup(true)}
              className="group/hdr flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-accent/50"
            >
              {chat.avatarVariants ? (
                <Avatar
                  name={name}
                  avatarVariants={chat.avatarVariants}
                  className="shrink-0 transition-transform motion-safe:group-hover/hdr:scale-105"
                />
              ) : (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground transition-transform motion-safe:group-hover/hdr:scale-105">
                  <Users className="size-4" />
                </div>
              )}
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate font-semibold">{name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {chat.participants.length} participant
                  {chat.participants.length === 1 ? "" : "s"} · Tap to manage
                </span>
              </div>
            </button>
          )}

          {chat.type === "group" && (
            <Button
              variant="outline"
              size="sm"
              aria-label="Manage group"
              onClick={() => setManagingGroup(true)}
            >
              <Settings2 className="size-4" />
              <span className="hidden sm:inline">Manage</span>
            </Button>
          )}
        </CardHeader>
        <PinnedMessagesBar
          chatId={chatId}
          participants={chat.participants}
          enabled={!!session}
          onJump={jumpToMessage}
        />
        <CardContent className="min-h-0 flex-1 px-0">
          {/* Two elements, not one: the outer div is the fixed-height viewport
              that scrolls, the inner one is the thread whose height changes as
              content loads. The ResizeObserver above watches both — a single
              element can't report its own content growing. `overscroll-contain`
              keeps a flick past either end from chaining out to the page. */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            data-testid="chat-scroll"
            className="h-full overflow-y-auto overscroll-contain"
          >
            <div
              ref={contentRef}
              className="flex min-h-full flex-col gap-2 px-4 py-4"
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
                  // Insert a day separator before the first message and before
                  // any message that starts a new local calendar day (issue
                  // #307). Messages arrive oldest-first, so comparing against the
                  // previous entry is enough.
                  const prev = messages[i - 1];
                  const showDaySeparator =
                    prev == null ||
                    localDayKey(prev.createdAt) !==
                      localDayKey(message.createdAt);
                  return (
                    <Fragment key={message.id}>
                      {showDaySeparator && (
                        <DateSeparator ms={message.createdAt} />
                      )}
                      <MessageBubble
                        message={message}
                        isOwn={isOwn}
                        isRead={message.readByUserIds.length > 0}
                        canModify={isOwn || session.user.role === "admin"}
                        canDeleteOthers={!isOwn && canManage}
                        onEdit={(content) =>
                          handleEditMessage(message.id, content)
                        }
                        onDelete={() => handleDeleteMessage(message.id)}
                        onReply={() =>
                          setReplyingTo({
                            id: message.id,
                            senderName: sender ? userLabel(sender) : "Someone",
                            contentType: message.contentType,
                            content: message.content,
                          })
                        }
                        senderLabel={
                          chat.type === "group" && sender
                            ? userLabel(sender)
                            : undefined
                        }
                        senderAvatar={
                          chat.type === "group" && sender && !isOwn
                            ? {
                                name: userAvatarName(sender),
                                avatarUrl: sender.avatarUrl,
                                avatarVariants: sender.avatarVariants,
                              }
                            : undefined
                        }
                        style={{ animationDelay: `${Math.min(i, 6) * 30}ms` }}
                      />
                    </Fragment>
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
          </div>
        </CardContent>

        <ChatComposer
          chatId={chatId}
          onSend={handleSend}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
        />
      </Card>

      {chat.type === "group" && (
        <GroupManagementDialog
          chat={chat}
          currentUser={session.user}
          open={managingGroup}
          onClose={() => setManagingGroup(false)}
        />
      )}
    </main>
  );
}
