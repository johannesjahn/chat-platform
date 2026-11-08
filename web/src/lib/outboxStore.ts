import type { Attachment } from "./attachments";
import type { ChatMessage, MessageContentType } from "./chats";
import { errorMessage } from "./errors";

// The state machine behind optimistic message sends (wired up to the API,
// the query cache and the offline queue in lib/outbox.ts). Kept free of
// those imports so it can be unit-tested on its own: Bun's module mocks are
// shared by every test file in a run, so stubbing ./api for it would break
// api.test.ts.
export type OutboxStatus = "sending" | "failed";

// What a reply's bubble quotes, as the composer's reply banner had it.
export type OutboxReplyPreview = {
  senderName: string;
  contentType: MessageContentType;
  content: string;
};

export type OutboxMessage = {
  clientId: string;
  chatId: number;
  // Same rule as the offline queue's `Owned`: never shown under another
  // account that logs in on this browser while a send is still out.
  ownerId: number | null;
  contentType: MessageContentType;
  content: string;
  attachmentId?: number;
  // The uploaded file, kept so the bubble can preview it while sending.
  attachment?: Attachment;
  parentMessageId?: number;
  replyPreview?: OutboxReplyPreview;
  createdAt: number;
  status: OutboxStatus;
  error?: string;
};

export type OutboxDeps = {
  // Sends one message. Resolves with the stored message or the server's
  // rejection; throws when there was no response at all.
  post: (
    entry: OutboxMessage,
  ) => Promise<{ message: ChatMessage } | { error: unknown }>;
  // The server stored it: show the real message. Runs in the same tick as
  // the entry's removal, so there's no frame with neither (or both).
  confirmed: (entry: OutboxMessage, message: ChatMessage) => void;
  // No response at all. Returns true when the message was handed off
  // elsewhere (the offline queue), taking it out of the outbox; otherwise
  // it's marked failed.
  handOff: (entry: OutboxMessage) => boolean;
};

export function createOutbox(deps: OutboxDeps) {
  let entries: OutboxMessage[] = [];
  const listeners = new Set<() => void>();

  function setEntries(next: OutboxMessage[]): void {
    entries = next;
    for (const listener of listeners) listener();
  }

  function update(clientId: string, patch: Partial<OutboxMessage>): void {
    setEntries(
      entries.map((entry) =>
        entry.clientId === clientId ? { ...entry, ...patch } : entry,
      ),
    );
  }

  function remove(clientId: string): void {
    setEntries(entries.filter((entry) => entry.clientId !== clientId));
  }

  // Sends go out one at a time per chat, in the order they were sent. Two
  // requests racing would let the second land first and take the lower id —
  // the thread would then reorder the user's own messages under them. Only
  // the network calls wait their turn; every bubble shows up immediately.
  const chatTails = new Map<number, Promise<void>>();

  function schedule(chatId: number, clientId: string): void {
    const tail = (chatTails.get(chatId) ?? Promise.resolve()).then(() =>
      deliver(clientId),
    );
    chatTails.set(chatId, tail);
    void tail.finally(() => {
      if (chatTails.get(chatId) === tail) chatTails.delete(chatId);
    });
  }

  async function deliver(clientId: string): Promise<void> {
    const entry = entries.find((e) => e.clientId === clientId);
    // Dismissed while it waited its turn.
    if (!entry || entry.status !== "sending") return;

    let result: Awaited<ReturnType<OutboxDeps["post"]>>;
    try {
      result = await deps.post(entry);
    } catch (err) {
      if (deps.handOff(entry)) remove(clientId);
      else update(clientId, { status: "failed", error: errorMessage(err) });
      return;
    }

    if ("error" in result) {
      update(clientId, {
        status: "failed",
        error: errorMessage(result.error),
      });
      return;
    }
    deps.confirmed(entry, result.message);
    remove(clientId);
  }

  return {
    getEntries: (): OutboxMessage[] => entries,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // Shows `entry` straight away and sends it once the chat's earlier sends
    // are done. Never throws: a failure becomes a "failed" entry.
    add(entry: Omit<OutboxMessage, "status" | "error">): void {
      setEntries([...entries, { ...entry, status: "sending" }]);
      schedule(entry.chatId, entry.clientId);
    },

    // Sends a failed message again, under the same `clientId` — if the
    // earlier attempt was stored after all, the server hands back that
    // message rather than storing a second one.
    retry(clientId: string): void {
      const entry = entries.find((e) => e.clientId === clientId);
      if (!entry || entry.status !== "failed") return;
      update(clientId, { status: "sending", error: undefined });
      schedule(entry.chatId, clientId);
    },

    dismiss(clientId: string): void {
      remove(clientId);
    },
  };
}
