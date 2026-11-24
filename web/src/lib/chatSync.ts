import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { components } from "./api-types";
import type { Chat, ChatMessage, ChatMessagesPage } from "./chats";
import { countsTowardUnread, hasLapsedMute } from "./chatMute";
import {
  archivedChatsListQueryKey,
  chatDetailQueryKey,
  chatMessagesQueryKey,
  chatsListQueryKey,
  chatsUnreadCountQueryKey,
  unreadChatsListQueryKey,
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
// - a new message in a chat that isn't on screen is counted into the unread
//   badge and made the listed chat's preview from the message the event
//   carries (issue #834), so that's no request either;
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
  // On "message_created": the message as a participant other than its
  // sender sees it — absent from a server that predates it.
  message?: ChatMessage;
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
    // Off screen (issue #834). This used to refetch the unread total and
    // the chat list for every recipient on every message — the two most
    // requested endpoints under load. Someone else's message is one more
    // unread, which the badge and the listed chat can count themselves, and
    // the event carries the message, which is the listed chat's new
    // preview and puts it back at the top. Only a chat this client has
    // nothing cached for, or a server that doesn't send the message, still
    // refetches the lists — at most once per LIST_REFETCH_WINDOW_MS while
    // messages keep arriving.
    if (event.senderId !== meId && !countUnread(queryClient, chatId)) {
      void queryClient.invalidateQueries({
        queryKey: chatsUnreadCountQueryKey,
      });
    }
    const { message } = event;
    if (
      message !== undefined &&
      message.id === event.messageId &&
      message.chatId === chatId &&
      placeNewestMessage(queryClient, chatId, message, version)
    ) {
      // Patched wherever it's listed. The one list that can *gain* it is
      // the Unread filter's, for someone else's message.
      if (
        event.senderId !== meId &&
        !listedIn(queryClient, unreadChatsListQueryKey, chatId)
      )
        refetchListsSoon(queryClient, "unread");
      return;
    }
    refetchListsSoon(queryClient);
    void queryClient.invalidateQueries({
      queryKey: chatDetailQueryKey(chatId),
    });
    return;
  }

  refetchChat(queryClient, chatId);
}

// One more unread message from someone else in `chatId`, counted into the
// cached list entry, the chat and the unread total without a request. Only
// for a chat in the main list — which holds accepted chats only, the only
// ones the total counts (message requests don't). False when it couldn't
// tell, for the caller to refetch the total instead.
function countUnread(queryClient: QueryClient, chatId: number): boolean {
  const listed = queryClient
    .getQueryData<InfiniteData<ChatsPage>>(chatsListQueryKey)
    ?.pages.flatMap((page) => page.chats)
    .find((chat) => chat.id === chatId);
  if (!listed) return false;
  const total = queryClient.getQueryState<UnreadChatCount>(
    chatsUnreadCountQueryKey,
  );
  if (!total?.data || total.fetchStatus === "fetching") return false;
  if (hasLapsedMute(listed)) return false;

  const bump = (chat: Chat): Chat => ({
    ...chat,
    unreadCount: chat.unreadCount + 1,
  });
  patchListedChat(queryClient, chatId, bump);
  queryClient.setQueryData<Chat>(chatDetailQueryKey(chatId), (chat) =>
    chat ? bump(chat) : chat,
  );
  // A muted chat's count is its own (issue #900).
  if (!countsTowardUnread(listed)) return true;
  queryClient.setQueryData<UnreadChatCount>(chatsUnreadCountQueryKey, {
    count: total.data.count + 1,
    chats: total.data.chats + (listed.unreadCount === 0 ? 1 : 0),
  });
  return true;
}

// How often the chat lists may be refetched for messages in chats that
// aren't open: the first in a quiet spell refetches at once, the rest of a
// burst share one refetch at the end of the window.
export const LIST_REFETCH_WINDOW_MS = 2_000;

const listRefetches = new WeakMap<
  QueryClient,
  {
    at: number;
    timer: ReturnType<typeof setTimeout> | undefined;
    // What the pending refetch covers.
    lists: "all" | "unread" | undefined;
  }
>();

// `"unread"` refetches only the Unread filter's list (see
// `applyChatUpdated`), `"all"` every chat list.
function refetchListsSoon(
  queryClient: QueryClient,
  lists: "all" | "unread" = "all",
): void {
  const state = listRefetches.get(queryClient) ?? {
    at: -Infinity,
    timer: undefined,
    lists: undefined,
  };
  listRefetches.set(queryClient, state);
  state.lists = state.lists === "all" ? "all" : lists;
  if (state.timer !== undefined) return;
  const refetch = () => {
    const which = state.lists;
    state.timer = undefined;
    state.at = Date.now();
    state.lists = undefined;
    void queryClient.invalidateQueries(
      which === "unread"
        ? { queryKey: unreadChatsListQueryKey, exact: true }
        : {
            // Chat lists, but not the unread total that shares their prefix.
            queryKey: chatsListQueryKey,
            predicate: (query) =>
              query.queryKey.length !== chatsUnreadCountQueryKey.length ||
              query.queryKey.at(-1) !== chatsUnreadCountQueryKey.at(-1),
          },
    );
  };
  const wait = state.at + LIST_REFETCH_WINDOW_MS - Date.now();
  if (wait <= 0) refetch();
  else state.timer = setTimeout(refetch, wait);
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
      // The unread total shares the prefix: `undefined` leaves it untouched,
      // where writing it back would clear a pending invalidation.
      if (!isChatsList(data)) return undefined;
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
// are ordered pinned first, then newest activity first — and otherwise stays where it is.
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
  // An archived chat (issue #900) isn't in the main list either, and leaves
  // the archived one once a message brings it back.
  if (chat.archived) {
    patchListedChat(queryClient, chat.id, () => chat);
    return;
  }
  dropArchivedChat(queryClient, chat.id);
  const sortsBefore = (a: Chat, b: Chat) => {
    if (!!a.pinned !== !!b.pinned) return !!a.pinned;
    return (
      a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.id > b.id)
    );
  };
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

function dropArchivedChat(queryClient: QueryClient, chatId: number): void {
  queryClient.setQueryData<InfiniteData<ChatsPage>>(
    archivedChatsListQueryKey,
    (data) =>
      data?.pages.some((page) => page.chats.some((c) => c.id === chatId))
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              chats: page.chats.filter((c) => c.id !== chatId),
            })),
          }
        : data,
  );
}

function placeChat(
  data: InfiniteData<ChatsPage>,
  chat: Chat,
  sortsBefore: (a: Chat, b: Chat) => boolean,
  onMissing: () => void,
): InfiniteData<ChatsPage> {
  const listed = data.pages.flatMap((page) => page.chats);
  const existing = listed.find((c) => c.id === chat.id);
  if (
    existing &&
    existing.updatedAt === chat.updatedAt &&
    !!existing.pinned === !!chat.pinned
  ) {
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
    queryClient.getQueryData<Chat>(detailKey) ??
    queryClient
      .getQueryData<InfiniteData<ChatsPage>>(chatsListQueryKey)
      ?.pages.flatMap((page) => page.chats)
      .find((c) => c.id === chat.id);

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
  if (
    before === undefined ||
    total.fetchStatus === "fetching" ||
    // It came out of a mute or the archive (or went in) since the total was
    // fetched, so the difference says nothing about it.
    hasLapsedMute(before) ||
    countsTowardUnread(before) !== countsTowardUnread(chat)
  ) {
    void queryClient.invalidateQueries({ queryKey: chatsUnreadCountQueryKey });
    return;
  }
  if (!countsTowardUnread(chat)) return;
  const read = before.unreadCount - chat.unreadCount;
  if (read === 0) return;
  const clearedChat = before.unreadCount > 0 && chat.unreadCount === 0 ? 1 : 0;
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
  const advance = (chat: Chat) => withNewestMessage(chat, message);
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

// `message` as `chat`'s preview, unless the chat already shows a newer one.
// `version`, when given, is the chat's version as of the message.
function withNewestMessage(
  chat: Chat,
  message: ChatMessage,
  version?: number,
): Chat {
  if (chat.lastMessage && chat.lastMessage.id >= message.id) return chat;
  return {
    ...chat,
    lastMessage: message,
    updatedAt: Math.max(chat.updatedAt, message.createdAt),
    version: Math.max(chat.version, version ?? chat.version),
    // A new message un-archives it (issue #900).
    archived: false,
  };
}

// A `message_created` event's message for a chat that isn't on screen
// (issue #834): made the preview of the chat in every cached list it's in,
// moved to where the main list now sorts it, and into the cached chat. Its
// unread count has already been counted (`countUnread`). False when nothing
// here has the chat cached — a chat this client hasn't seen, which only a
// refetch can bring in.
function placeNewestMessage(
  queryClient: QueryClient,
  chatId: number,
  message: ChatMessage,
  version: number,
): boolean {
  const detail = queryClient.getQueryData<Chat>(chatDetailQueryKey(chatId));
  if (detail) {
    const next = withNewestMessage(detail, message, version);
    if (next !== detail)
      queryClient.setQueryData<Chat>(chatDetailQueryKey(chatId), next);
  }
  const base = listedIn(queryClient, chatsListQueryKey, chatId) ?? detail;
  if (!base) return false;
  // Back from the archive, everything unread in it counts again.
  if (base.archived)
    void queryClient.invalidateQueries({ queryKey: chatsUnreadCountQueryKey });
  upsertListedChat(queryClient, withNewestMessage(base, message, version));
  return true;
}

// `chatId`'s entry in a cached chat list under `queryKey` (a prefix: the
// main list's key matches every list).
function listedIn(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  chatId: number,
): Chat | undefined {
  for (const [, data] of queryClient.getQueriesData<unknown>({ queryKey })) {
    if (!isChatsList(data)) continue;
    const listed = data.pages
      .flatMap((page) => page.chats)
      .find((chat) => chat.id === chatId);
    if (listed) return listed;
  }
  return undefined;
}
