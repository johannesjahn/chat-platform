import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { components } from "./api-types";
import type { Chat, ChatMessage, ChatMessagesPage } from "./chats";
import {
  chatDetailQueryKey,
  chatMessagesQueryKey,
  chatsListQueryKey,
  chatsUnreadCountQueryKey,
} from "./chatQueryKeys";
import { classifyChatVersion, recordChatVersion } from "./chatVersions";

// How a chat's cached queries follow its `chat_updated` events (issue #749).
//
// Every event used to refetch the chat list, the chat and its message
// window, for everyone in the chat — so one message cost an open viewer ~10
// requests (the message, their own mark-read, and that read's echo, each
// refetching all three), and the receipts multiplied that by the size of
// the group. The server now says what changed (`ChatChange` in
// src/Realtime.ts), and this does only what that change needs:
//
// - a read receipt is patched into the cached messages, with no request;
// - a new message in a conversation that's on screen fetches just the new
//   message: the conversation's own mark-read brings the chat back with
//   it (`applyMarkedRead`), and its own messages patch the preview
//   (`applyNewestMessage`), so neither the list nor the chat is refetched;
// - anything else, a missed version, or an event from a server that
//   predates `change`, refetches all three, as before.

type ChatsPage = components["schemas"]["ChatsPage"];
type UnreadChatCount = components["schemas"]["UnreadChatCount"];

export type ChatUpdatedEvent = {
  type: "chat_updated";
  chatId: number;
  version: number;
  // Absent from a server that predates it, and on any change that has no
  // narrower meaning (see ChatEvent in src/Realtime.ts). A value this
  // client doesn't know is treated the same way.
  change?: string;
  messageId?: number;
  senderId?: number;
  userId?: number;
  fromMessageId?: number;
  lastReadMessageId?: number;
};

// --- Conversations on screen ------------------------------------------------

// Chats a conversation is showing right now, on a visible page — counted,
// since the same chat can be open twice (the page and the search preview).
// Only these defer to the conversation for the list and the chat.
const inView = new Map<number, number>();

export function holdChatInView(chatId: number): () => void {
  inView.set(chatId, (inView.get(chatId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inView.get(chatId) ?? 1) - 1;
    if (left > 0) inView.set(chatId, left);
    else inView.delete(chatId);
  };
}

export function isChatInView(chatId: number): boolean {
  return inView.has(chatId);
}

// Chats this tab is marking read right now. The server publishes a read
// before it answers the request, so the echo of our own read can beat our
// own response here — and that response is about to apply it anyway.
const ownReadsInFlight = new Map<number, number>();

export function beginOwnRead(chatId: number): () => void {
  ownReadsInFlight.set(chatId, (ownReadsInFlight.get(chatId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (ownReadsInFlight.get(chatId) ?? 1) - 1;
    if (left > 0) ownReadsInFlight.set(chatId, left);
    else ownReadsInFlight.delete(chatId);
  };
}

// --- The event ---------------------------------------------------------------

function refetchChat(queryClient: QueryClient, chatId: number): void {
  void queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
  void queryClient.invalidateQueries({ queryKey: chatDetailQueryKey(chatId) });
  void queryClient.invalidateQueries({
    queryKey: chatMessagesQueryKey(chatId),
  });
}

export function applyChatUpdated(
  queryClient: QueryClient,
  event: ChatUpdatedEvent,
  meId: number,
): void {
  const { chatId, version } = event;
  // `version` (see Chat.version, src/db/schema.ts) tells a redelivery of
  // something already applied ("stale" — nothing to do) from a jump past
  // one or more missed updates ("gap", issue #55). After a gap there's no
  // knowing what changed, so only a full refetch is safe.
  const classification = classifyChatVersion(chatId, version);
  if (classification === "stale") return;
  if (classification === "gap") {
    console.warn(
      `Realtime: missed update(s) for chat ${chatId} (jumped to version ${version})`,
    );
  }
  recordChatVersion(chatId, version);
  if (classification === "gap") return refetchChat(queryClient, chatId);

  if (
    event.change === "read" &&
    event.userId != null &&
    event.lastReadMessageId != null
  ) {
    if (event.userId !== meId) {
      patchReadReceipt(
        queryClient,
        chatId,
        event.userId,
        event.fromMessageId ?? 0,
        event.lastReadMessageId,
      );
      return;
    }
    // Our own read. From this tab, its response is on its way; from
    // another tab or device, the unread counts here are out of date — but
    // the messages aren't, so they're left alone.
    if (ownReadsInFlight.has(chatId)) return;
    void queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
    void queryClient.invalidateQueries({
      queryKey: chatDetailQueryKey(chatId),
    });
    return;
  }

  if (event.change === "message_created") {
    void queryClient.invalidateQueries({
      queryKey: chatMessagesQueryKey(chatId),
    });
    // On screen, the conversation takes it from here: it marks the new
    // message read (and that response carries the chat) or, for one of our
    // own, patches the preview from it.
    if (isChatInView(chatId)) return;
    void queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
    void queryClient.invalidateQueries({
      queryKey: chatDetailQueryKey(chatId),
    });
    return;
  }

  refetchChat(queryClient, chatId);
}

// --- Patches -----------------------------------------------------------------

// `readerId` has now read everything from others in (`fromId`, `toId`].
function withReader(
  message: ChatMessage,
  readerId: number,
  fromId: number,
  toId: number,
): ChatMessage {
  if (
    message.senderId === readerId ||
    message.id <= fromId ||
    message.id > toId ||
    message.readByUserIds.includes(readerId)
  )
    return message;
  return {
    ...message,
    readByUserIds: [...message.readByUserIds, readerId].sort((a, b) => a - b),
  };
}

function isChatsList(data: unknown): data is InfiniteData<ChatsPage> {
  return (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as { pages?: unknown }).pages)
  );
}

// Applies `update` to `chatId`'s entry in every cached chat list (the full
// one and the Unread filter's), keeping each list's identity when nothing
// changed.
function patchListedChat(
  queryClient: QueryClient,
  chatId: number,
  update: (chat: Chat) => Chat,
): void {
  queryClient.setQueriesData<unknown>(
    { queryKey: chatsListQueryKey },
    (data: unknown) => {
      if (!isChatsList(data)) return data;
      let changed = false;
      const pages = data.pages.map((page) => {
        const chats = page.chats.map((chat) => {
          if (chat.id !== chatId) return chat;
          const next = update(chat);
          if (next !== chat) changed = true;
          return next;
        });
        return changed ? { ...page, chats } : page;
      });
      return changed ? { ...data, pages } : data;
    },
  );
}

export function patchReadReceipt(
  queryClient: QueryClient,
  chatId: number,
  readerId: number,
  fromId: number,
  toId: number,
): void {
  queryClient.setQueryData<ChatMessagesPage>(
    chatMessagesQueryKey(chatId),
    (prev) => {
      if (!prev) return prev;
      let changed = false;
      const messages = prev.messages.map((m) => {
        const next = withReader(m, readerId, fromId, toId);
        if (next !== m) changed = true;
        return next;
      });
      return changed ? { ...prev, messages } : prev;
    },
  );
  const patchLast = (chat: Chat): Chat => {
    if (!chat.lastMessage) return chat;
    const lastMessage = withReader(chat.lastMessage, readerId, fromId, toId);
    return lastMessage === chat.lastMessage ? chat : { ...chat, lastMessage };
  };
  queryClient.setQueryData<Chat>(chatDetailQueryKey(chatId), (prev) =>
    prev ? patchLast(prev) : prev,
  );
  patchListedChat(queryClient, chatId, patchLast);
}

// Puts `chat` into every cached chat list. A chat whose `updatedAt` moved
// (a new message) goes back to where the server would list it — the lists
// are ordered newest activity first — and otherwise stays where it is.
// One the full list hasn't loaded is left for that list's next refetch,
// unless it now sorts into the loaded range, where it's refetched now.
function upsertListedChat(queryClient: QueryClient, chat: Chat): void {
  // A message request (issue #785) isn't in the main list until it's
  // accepted, so it's only patched where it's already listed — the
  // requests list — never placed into the main one.
  if (chat.messageRequest) {
    patchListedChat(queryClient, chat.id, () => chat);
    return;
  }
  const sortsBefore = (a: Chat, b: Chat) =>
    a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.id > b.id);
  let missing = false;
  queryClient.setQueryData<InfiniteData<ChatsPage>>(
    chatsListQueryKey,
    (data) =>
      data ? placeChat(data, chat, sortsBefore, () => (missing = true)) : data,
  );
  // The Unread filter's list keeps a chat that's just been read until it's
  // next fetched (rather than pulling it out from under the reader), and
  // never gains one here.
  patchListedChat(queryClient, chat.id, () => chat);
  if (missing)
    void queryClient.invalidateQueries({
      queryKey: chatsListQueryKey,
      exact: true,
    });
}

function placeChat(
  data: InfiniteData<ChatsPage>,
  chat: Chat,
  sortsBefore: (a: Chat, b: Chat) => boolean,
  onMissing: () => void,
): InfiniteData<ChatsPage> {
  const listed = data.pages.flatMap((page) => page.chats);
  const existing = listed.find((c) => c.id === chat.id);
  if (existing && existing.updatedAt === chat.updatedAt) {
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        chats: page.chats.map((c) => (c.id === chat.id ? chat : c)),
      })),
    };
  }
  const without = data.pages.map((page) => ({
    ...page,
    chats: page.chats.filter((c) => c.id !== chat.id),
  }));
  // Into the first page it sorts before something in, or the end of the
  // last page if that's the end of the list.
  for (const page of without) {
    const at = page.chats.findIndex((c) => sortsBefore(chat, c));
    if (at !== -1) {
      page.chats.splice(at, 0, chat);
      return { ...data, pages: without };
    }
  }
  const last = without.at(-1);
  if (last && last.nextCursor === null) {
    last.chats.push(chat);
    return { ...data, pages: without };
  }
  if (!existing) {
    onMissing();
    return data;
  }
  // It moved past what's loaded — drop it; the list's next page has it.
  return { ...data, pages: without };
}

// Applies a `POST /chats/:id/read` response: it *is* the chat as it now
// stands, so it's written straight into the chat and the lists rather than
// refetching them (issue #749). The unread total moves by what this chat's
// count did. Any of those refetches already in flight may have been read
// before this did, so they're redone instead of being left to land on top.
export function applyMarkedRead(queryClient: QueryClient, chat: Chat): void {
  const detailKey = chatDetailQueryKey(chat.id);
  const before =
    queryClient.getQueryData<Chat>(detailKey)?.unreadCount ??
    queryClient
      .getQueryData<InfiniteData<ChatsPage>>(chatsListQueryKey)
      ?.pages.flatMap((page) => page.chats)
      .find((c) => c.id === chat.id)?.unreadCount;

  recordChatVersion(chat.id, chat.version);
  const detailFetching =
    queryClient.getQueryState(detailKey)?.fetchStatus === "fetching";
  queryClient.setQueryData<Chat>(detailKey, chat);
  if (detailFetching)
    void queryClient.invalidateQueries({ queryKey: detailKey });

  const listFetching =
    queryClient.isFetching({ queryKey: chatsListQueryKey, exact: true }) > 0;
  upsertListedChat(queryClient, chat);
  if (listFetching)
    void queryClient.invalidateQueries({
      queryKey: chatsListQueryKey,
      exact: true,
    });

  const total = queryClient.getQueryState<UnreadChatCount>(
    chatsUnreadCountQueryKey,
  );
  if (!total?.data) return;
  if (before === undefined || total.fetchStatus === "fetching") {
    void queryClient.invalidateQueries({ queryKey: chatsUnreadCountQueryKey });
    return;
  }
  const read = before - chat.unreadCount;
  if (read === 0) return;
  const clearedChat = before > 0 && chat.unreadCount === 0 ? 1 : 0;
  queryClient.setQueryData<UnreadChatCount>(chatsUnreadCountQueryKey, {
    count: Math.max(0, total.data.count - read),
    chats: Math.max(0, total.data.chats - clearedChat),
  });
}

// A message of our own became the chat's newest — sent from here (the
// outbox's response) or from another device while the conversation is open
// (no refetch of the list or chat happens then; see `applyChatUpdated`).
// Nothing about unread counts changes, so the preview is all there is to
// update, and the message itself is the new preview.
export function applyNewestMessage(
  queryClient: QueryClient,
  chatId: number,
  message: ChatMessage,
): void {
  const advance = (chat: Chat): Chat =>
    chat.lastMessage && chat.lastMessage.id >= message.id
      ? chat
      : {
          ...chat,
          lastMessage: message,
          updatedAt: Math.max(chat.updatedAt, message.createdAt),
        };
  const detail = queryClient.getQueryData<Chat>(chatDetailQueryKey(chatId));
  if (detail) {
    const next = advance(detail);
    if (next !== detail) {
      queryClient.setQueryData<Chat>(chatDetailQueryKey(chatId), next);
    }
  }
  const listed = queryClient
    .getQueryData<InfiniteData<ChatsPage>>(chatsListQueryKey)
    ?.pages.flatMap((page) => page.chats)
    .find((c) => c.id === chatId);
  const base = listed ?? detail;
  if (!base) {
    void queryClient.invalidateQueries({
      queryKey: chatsListQueryKey,
      exact: true,
    });
    return;
  }
  const next = advance(base);
  if (next !== base || !listed) upsertListedChat(queryClient, next);
}
