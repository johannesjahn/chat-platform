import type { ForwardOutcome } from "@/components/chat/ForwardDialog";
import type { ToastOptions } from "@/components/ui/toast";

const FORWARD_FAILURE_LABELS = {
  unavailable: "you're not in it",
  blocked: "blocked",
  quota_exceeded: "your storage is full",
  invalid_content: "it can't be sent",
} as const;

// What to tell someone once a forward (issue #601) comes back: how many of
// the chats they picked got it, and which didn't and why. A single target
// that worked offers a jump to it.
export function forwardToast(
  { results, chatNames }: ForwardOutcome,
  openChat: (chatId: number) => void,
): ToastOptions {
  const sent = results.filter((r) => r.message !== null);
  const failed = results.filter((r) => r.error !== null);
  const chats = (n: number) => `${n} ${n === 1 ? "chat" : "chats"}`;
  const description =
    failed.length > 0
      ? `Not sent to ${failed
          .map(
            (r) =>
              `${chatNames.get(r.chatId) ?? "a chat"} (${FORWARD_FAILURE_LABELS[r.error!.reason]})`,
          )
          .join(", ")}`
      : undefined;
  const only = results.length === 1 ? sent[0] : undefined;
  return {
    title:
      failed.length === 0
        ? `Forwarded to ${chats(sent.length)}`
        : sent.length === 0
          ? "Couldn't forward the message"
          : `Forwarded to ${sent.length} of ${chats(results.length)}`,
    description,
    tone: failed.length === 0 ? "success" : "warning",
    action: only
      ? { label: "Open chat", onClick: () => openChat(only.chatId) }
      : undefined,
  };
}
