import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ChatListFilter } from "@/components/ChatList";

type ChatListFilterState = [
  ChatListFilter,
  Dispatch<SetStateAction<ChatListFilter>>,
];

/**
 * The filter state behind a `ChatListFilterBar`, starting unfiltered. The
 * `/chats` layout owns it and provides it through `ChatListFilterProvider`
 * on every layout, so on a phone too the filter is still set when Back
 * returns from a conversation to the list — just as the desktop pane keeps
 * it while conversations change beside it (issue #763).
 */
export function useChatListFilterState(): ChatListFilterState {
  return useState<ChatListFilter>({ query: "", show: "all" });
}

const ChatListFilterContext = createContext<ChatListFilterState | null>(null);

export const ChatListFilterProvider = ChatListFilterContext.Provider;

/** The `/chats` layout's filter state, for a page rendered inside it. */
export function useChatListFilter(): ChatListFilterState {
  const state = useContext(ChatListFilterContext);
  if (!state) {
    throw new Error("useChatListFilter needs a ChatListFilterProvider");
  }
  return state;
}
