import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Loader2 } from "lucide-react";
import {
  ChatComposer,
  type ChatComposerHandle,
  type ReplyTarget,
} from "@/components/ChatComposer";
import {
  CHAT_HEADER_CLASS,
  ConversationHeader,
} from "@/components/chat/ConversationHeader";
import { DropOverlay } from "@/components/chat/DropOverlay";
import { useFileDrop } from "@/components/chat/useFileDrop";
import { ForwardDialog } from "@/components/chat/ForwardDialog";
import { forwardToast } from "@/components/chat/forwardToast";
import { MessageRequestBar } from "@/components/chat/MessageRequestBar";
import { PendingMessageList } from "@/components/chat/PendingMessageList";
import {
  sendFromComposer,
  usePendingMessages,
} from "@/components/chat/pendingMessages";
import {
  ThreadMessages,
  TypingIndicator,
} from "@/components/chat/ThreadMessages";
import { useMarkReadWhileVisible } from "@/components/chat/useMarkReadWhileVisible";
import { useThreadScroll } from "@/components/chat/useThreadScroll";
import { GroupManagementDialog } from "@/components/GroupManagementDialog";
import { LoginPrompt } from "@/components/LoginPrompt";
import { PinnedMessagesBar } from "@/components/PinnedMessagesBar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { $api } from "@/lib/api";
import { useSession } from "@/lib/auth";
import {
  setChatDetailsOpen,
  useChatDetailsAsPanel,
  useChatDetailsOpen,
  useJumpRequests,
} from "@/lib/chatDetails";
import { canManageChat } from "@/lib/chatRoles";
import {
  chatDetailQueryKey,
  chatDisplayName,
  type ChatMessage,
  useChatDetail,
  useChatMessages,
  useChatsTwoPane,
} from "@/lib/chats";
import { useOnlineStatus } from "@/lib/online";
import { useIsDesktop } from "@/lib/media";
import { useIsOnline } from "@/lib/presence";
import { useUserStatus } from "@/lib/status";
import { clearTyping } from "@/lib/typing";
import { cn } from "@/lib/utils";
import { useImmersiveShell } from "@/lib/viewport";
import { usePageTitle } from "@/lib/title";

// The conversation's <main> and card. Below `lg` it's the centred card it
// always was; at `lg`+ it sits in the two-pane layout's right pane (see
// chats/route.tsx) and fills it edge to edge — no card frame, no margins —
// so it reads as an app rather than a document.
const CHAT_MAIN_CLASS =
  "mx-auto flex min-h-0 w-full max-w-2xl grow basis-0 flex-col sm:px-4 sm:py-6 lg:max-w-none lg:p-0";
const CHAT_CARD_CLASS =
  "flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-none border-x-0 py-0 sm:rounded-xl sm:border-x lg:rounded-none lg:border-0 lg:bg-transparent lg:shadow-none lg:backdrop-blur-none lg:hover:border-transparent";

/**
 * One conversation: its header, thread and composer, plus everything that
 * keeps them honest — paging older history in, staying pinned to the newest
 * message, jumping to a quoted/pinned/searched message, marking it read,
 * queueing sends while offline.
 *
 * Rendered by the `/chats/$id` route (`variant="page"`) and by a desktop
 * docked chat window (`variant="docked"`, issue #554) — the same component
 * at two densities rather than a second chat implementation. The docked
 * variant leaves out what only makes sense as a page: the immersive shell,
 * the tab title, its own header (the dock window draws a compact one), the
 * pinned bar and chat details.
 *
 * Chat details are the group settings modal, or at `xl`+ in the two-pane
 * messenger the details panel beside the conversation (issue #563) — that
 * panel is the chats layout's, so this only toggles it and takes its
 * "show this message" requests.
 *
 * Callers key it by chat id, so every hook (including the message
 * pagination window in `useChatMessages`) starts fresh per chat instead of a
 * stale window "leaking" across chats.
 */
export function ChatConversation({
  chatId,
  targetMessageId,
  variant = "page",
  autoFocusComposer,
}: {
  chatId: number;
  // Open scrolled to (and highlighting) this message instead of the newest
  // one — `?message=<id>` on the page, a search hit in the search preview.
  targetMessageId?: number;
  variant?: "page" | "docked";
  // Whether the composer takes focus on open. Defaults to yes in a docked
  // window (opening one means you're about to type) and in the desktop
  // two-pane view; the search preview turns it off so ↑/↓ keep moving
  // through results.
  autoFocusComposer?: boolean;
}) {
  const docked = variant === "docked";
  // A phone thread is as narrow as a docked window, so its bubbles float
  // their actions the same way (see `compact` on MessageBubble).
  const isDesktop = useIsDesktop();
  const session = useSession();
  const queryClient = useQueryClient();
  const isOnline = useOnlineStatus();

  const {
    data: chat,
    isLoading: chatLoading,
    isFetching: chatFetching,
    error: chatError,
  } = useChatDetail(chatId, !!session);
  const {
    data: messagesData,
    isLoading: messagesLoading,
    isFetching: messagesFetching,
    loadEarlier,
  } = useChatMessages(chatId, !!session);

  // A 403/404 is the server saying this viewer can't — or can no longer —
  // see this chat: they were removed from the group, it was deleted, or the
  // cached copy belongs to whoever used this browser before (issue #478).
  // Unlike a network failure, that's authoritative, so the cached
  // conversation is dropped rather than kept on screen.
  const accessDenied = isAccessDenied(chatError);
  useEffect(() => {
    if (!accessDenied) return;
    const cache = queryClient.getQueryCache();
    // The detail query keeps its error (so this view shows it) but loses
    // its data; the rest of the chat's queries are simply discarded.
    cache
      .find({ queryKey: chatDetailQueryKey(chatId), exact: true })
      ?.setState({
        data: undefined,
        dataUpdatedAt: 0,
      });
    queryClient.removeQueries({
      queryKey: ["chats", chatId],
      predicate: (query) => query.queryKey[2] !== "detail",
    });
  }, [accessDenied, chatId, queryClient]);

  // For a direct chat, "online" is a property of the one other participant;
  // group chats don't show a single presence dot. Both hooks must run
  // unconditionally (before the loading/error early returns below), so they
  // tolerate `chat`/`session` still being undefined.
  const otherParticipant =
    chat?.type === "direct"
      ? chat.participants.find((p) => p.userId !== session?.user.id)
      : undefined;
  const otherParticipantId = otherParticipant?.userId;
  usePageTitle(
    chat && session && !docked
      ? chatDisplayName(chat, session.user.id)
      : undefined,
  );
  const otherParticipantOnline = useIsOnline(otherParticipantId);
  const otherParticipantStatus = useUserStatus(
    otherParticipantId,
    otherParticipant,
  );

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
  useImmersiveShell(!docked && !!session && (chatLoading || chat != null));

  const [managingGroup, setManagingGroup] = useState(false);
  const detailsAsPanel = useChatDetailsAsPanel() && !docked;
  const detailsOpen = useChatDetailsOpen();
  // The group header and "Manage" open the modal, or at `xl` the panel.
  function openDetails() {
    if (detailsAsPanel) setChatDetailsOpen(true);
    else setManagingGroup(true);
  }
  // The message a reply is currently being composed against (issue #217), or
  // null when composing a normal message.
  const [replyingTo, setReplyingTo] = useState<ReplyTarget | null>(null);
  // The message being forwarded (issue #601). Kept while the picker animates
  // out after `open` drops, then cleared.
  const [forwarding, setForwarding] = useState<{
    message: ChatMessage;
    open: boolean;
  } | null>(null);
  const showToast = useToast();
  const navigate = useNavigate();
  const twoPane = useChatsTwoPane();
  const composerRef = useRef<ChatComposerHandle | null>(null);
  // `↑` in an empty composer opens your newest text message's editor
  // (issue #554); the counter replays it for the same message.
  const [editRequest, setEditRequest] = useState<{
    messageId: number;
    key: number;
  } | null>(null);
  // Files dragged over the conversation become the message's attachment.
  const fileDrop = useFileDrop((file) => composerRef.current?.attachFile(file));

  const messages = messagesData?.messages ?? [];
  const pendingMessages = usePendingMessages(chatId, messagesData?.messages);

  const myUserId = session?.user.id;
  const newestMessage = messages[messages.length - 1];
  const newestMessageId = newestMessage?.id;
  const newestMessageSenderId = newestMessage?.senderId;

  const {
    scrollRef,
    contentRef,
    restorationId,
    onScroll,
    jumpToMessage,
    jumpHighlight,
    loadingEarlier,
  } = useThreadScroll({
    messages,
    myUserId,
    chatReady: chat != null,
    newestPendingClientId: pendingMessages.at(-1)?.clientId,
    hasEarlier: messagesData?.hasEarlier,
    loadEarlier,
    targetMessageId,
    messagesLoading,
  });

  // A newly-arrived message means its sender is done typing — clear their
  // indicator immediately instead of leaving it up until the TTL in
  // lib/typing.ts lapses on its own, which otherwise left the dots visibly
  // animating below a message that had already been sent.
  useEffect(() => {
    if (newestMessageId == null || newestMessageSenderId == null) return;
    clearTyping(chatId, newestMessageSenderId);
  }, [chatId, newestMessageId, newestMessageSenderId]);

  // A pinned, starred or media row picked in the details panel.
  useJumpRequests(docked ? undefined : chatId, (messageId) => {
    void jumpToMessage(messageId);
  });

  useMarkReadWhileVisible({
    chatId,
    myUserId,
    chat,
    messages,
    chatFetching,
    messagesFetching,
  });

  function editLastMessage() {
    const mine = [...messages]
      .reverse()
      .find((m) => m.senderId === session?.user.id && m.contentType === "text");
    if (!mine) return;
    setEditRequest((prev) => ({
      messageId: mine.id,
      key: (prev?.key ?? 0) + 1,
    }));
  }

  function focusComposer() {
    composerRef.current?.focus();
  }

  if (!session) {
    // The dock only exists for a signed-in viewer; this is the page's case.
    if (docked) return null;
    return (
      <main className="mx-auto flex w-full max-w-2xl justify-center px-4 py-10">
        <LoginPrompt
          pageHeading
          title="Log in to view this chat"
          description="Conversations are only visible to signed-in users."
        />
      </main>
    );
  }

  if (chatLoading && docked) {
    return (
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 p-3">
        <Skeleton className="h-9 w-2/3 self-start rounded-2xl" />
        <Skeleton className="h-9 w-1/2 self-end rounded-2xl" />
      </div>
    );
  }

  if (chatLoading) {
    return (
      <main className={CHAT_MAIN_CLASS}>
        <h1 className="sr-only">Loading conversation</h1>
        <Card className={CHAT_CARD_CLASS}>
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

  if (!chat || accessDenied) {
    // Keyed on `!chat` (plus an authoritative denial), not on any
    // `chatError`: once a chat
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
    // a connectivity problem. Its copy deliberately doesn't echo the server's
    // message ("Chat 999 not found" just repeats the title) and covers both
    // cases alike, so it never reveals whether a chat you're not in exists.
    const isApiError =
      accessDenied || (chatError != null && !(chatError instanceof Error));
    if (docked) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-4 text-center text-sm">
          <p className="font-medium">
            {isApiError ? "Chat not found" : "Can't load this conversation"}
          </p>
          <p className="text-xs text-muted-foreground">
            {isApiError
              ? "It may have been deleted, or you're not a member."
              : "Try again in a moment."}
          </p>
        </div>
      );
    }
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <Card>
          <CardHeader>
            <h1 className="text-lg font-semibold">
              {isApiError ? "Chat not found" : "Can't load this conversation"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {isApiError
                ? "It may have been deleted, or you're not a member."
                : isOnline
                  ? "Something went wrong reaching the server. Try again in a moment."
                  : "You're offline, and this conversation hasn't been loaded on this device yet."}
            </p>
          </CardHeader>
          <CardFooter>
            <Button asChild>
              <Link to="/chats">
                <ArrowLeft className="size-4" />
                Back to chats
              </Link>
            </Button>
          </CardFooter>
        </Card>
      </main>
    );
  }

  const name = chatDisplayName(chat, session.user.id);
  // Mirrors the backend's `requireChatManager` (see src/chats/access.ts).
  const canManage = canManageChat(chat, session.user);

  async function handleEditMessage(messageId: number, content: string) {
    // No manual refetch here either — same reasoning as a send, the
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

  // The thread and the composer, shared by both variants.
  const thread = (
    <>
      {/* Two elements, not one: the outer div is the fixed-height viewport
        that scrolls, the inner one is the thread whose height changes as
        content loads. The ResizeObserver in useThreadScroll watches both — a
        single element can't report its own content growing.
        `overscroll-contain` keeps a flick past either end from chaining out
        to the page. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-scroll-restoration-id={restorationId}
        data-testid="chat-scroll"
        className="h-full overflow-y-auto overflow-x-hidden overscroll-contain"
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
            <ThreadMessages
              chat={chat}
              messages={messages}
              me={session.user}
              canManage={canManage}
              compact={docked || !isDesktop}
              jumpHighlight={jumpHighlight}
              editRequest={editRequest}
              onEdit={handleEditMessage}
              onDelete={handleDeleteMessage}
              onReply={setReplyingTo}
              onForward={(message) => setForwarding({ message, open: true })}
              onJumpTo={(messageId) => void jumpToMessage(messageId)}
              onEditEnd={focusComposer}
            />
          )}

          {!messagesLoading && <PendingMessageList items={pendingMessages} />}

          <TypingIndicator
            chatId={chatId}
            meId={session.user.id}
            showNames={chat.type === "group"}
          />
        </div>
      </div>
      {/* Portalled: a docked window's own transform would otherwise make it
          the containing block of the picker's fixed backdrop. */}
      {forwarding &&
        createPortal(
          <ForwardDialog
            key={forwarding.message.id}
            open={forwarding.open}
            message={forwarding.message}
            onClose={() =>
              setForwarding((prev) => prev && { ...prev, open: false })
            }
            onExited={() => setForwarding(null)}
            onForwarded={(outcome) => {
              setForwarding((prev) => prev && { ...prev, open: false });
              showToast(
                forwardToast(
                  outcome,
                  (id) =>
                    void navigate({
                      to: "/chats/$id",
                      params: { id: String(id) },
                    }),
                ),
              );
            }}
          />,
          document.body,
        )}
    </>
  );
  // A message request (issue #785) is read-only until it's accepted.
  const composer = chat?.messageRequest ? (
    <MessageRequestBar chat={chat} />
  ) : (
    <ChatComposer
      ref={composerRef}
      chatId={chatId}
      onSend={(values) => sendFromComposer(chatId, values, replyingTo)}
      replyingTo={replyingTo}
      onCancelReply={() => setReplyingTo(null)}
      onEditLast={editLastMessage}
      autoFocus={autoFocusComposer ?? (twoPane || docked)}
    />
  );

  if (docked) {
    // A docked window draws its own compact header around this; the rest
    // of the conversation — thread, typing, composer, drop-to-attach — is
    // the same as the page's.
    return (
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        {...fileDrop.handlers}
      >
        {fileDrop.dragging && <DropOverlay />}
        <div className="min-h-0 flex-1">{thread}</div>
        {composer}
      </div>
    );
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
    <main className={CHAT_MAIN_CLASS}>
      {/* The visible name sits inside the header's link/button, which can't
          hold a heading — so the page's heading is a hidden one named after
          it. Named by `aria-label` rather than text so the name isn't on the
          page twice (the header and the chat list rows are found by it). */}
      <h1 className="sr-only" aria-label={name} />
      <Card
        className={cn(
          CHAT_CARD_CLASS,
          "relative motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500",
        )}
        {...fileDrop.handlers}
      >
        {fileDrop.dragging && <DropOverlay />}
        <ConversationHeader
          chat={chat}
          name={name}
          otherParticipant={otherParticipant}
          otherParticipantOnline={otherParticipantOnline}
          otherParticipantStatus={otherParticipantStatus}
          detailsAsPanel={detailsAsPanel}
          detailsOpen={detailsOpen}
          onOpenDetails={openDetails}
        />
        <PinnedMessagesBar
          chatId={chatId}
          participants={chat.participants}
          enabled={!!session}
          onJump={(messageId) => void jumpToMessage(messageId)}
        />
        <CardContent className="min-h-0 flex-1 px-0">{thread}</CardContent>

        {composer}
      </Card>

      {chat.type === "group" && !detailsAsPanel && (
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

function isAccessDenied(error: unknown): boolean {
  if (error == null || typeof error !== "object" || error instanceof Error)
    return false;
  const tag = (error as { _tag?: unknown })._tag;
  return tag === "Forbidden" || tag === "NotFound";
}
