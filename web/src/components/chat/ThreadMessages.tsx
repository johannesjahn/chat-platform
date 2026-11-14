import { type CSSProperties, Fragment } from "react";
import type { ReplyTarget } from "@/components/ChatComposer";
import { DateSeparator } from "@/components/DateSeparator";
import { MessageBubble } from "@/components/MessageBubble";
import { TypingDots } from "@/components/reactbits/TypingDots";
import {
  type Chat,
  type ChatMessage,
  localDayKey,
  wasShownBeforeConfirm,
} from "@/lib/chats";
import { useTypingUsers } from "@/lib/typing";
import { userAvatarName, userHandle, userLabel } from "@/lib/users";

// Splits oldest-first messages into runs sharing a local calendar day, keeping
// each message's index in the full list (used for the entry-animation stagger).
function groupByDay<T extends { createdAt: number }>(messages: T[]) {
  const groups: { message: T; i: number }[][] = [];
  let lastKey: string | undefined;
  messages.forEach((message, i) => {
    const key = localDayKey(message.createdAt);
    if (key !== lastKey) groups.push([]);
    groups[groups.length - 1]!.push({ message, i });
    lastKey = key;
  });
  return groups;
}

/**
 * The thread's confirmed messages, a date separator at the top of each day,
 * one MessageBubble each (split out of ChatConversation in issue #811). The
 * callbacks are per message; what to do with them is the conversation's.
 */
export function ThreadMessages({
  chat,
  messages,
  me,
  canManage,
  compact,
  jumpHighlight,
  editRequest,
  onEdit,
  onDelete,
  onReply,
  onForward,
  onJumpTo,
  onEditEnd,
}: {
  chat: Chat;
  messages: ChatMessage[];
  me: { id: number; role: string };
  canManage: boolean;
  compact: boolean;
  jumpHighlight: { messageId: number; key: number } | null;
  editRequest: { messageId: number; key: number } | null;
  onEdit: (messageId: number, content: string) => Promise<void>;
  onDelete: (messageId: number) => Promise<void>;
  onReply: (target: ReplyTarget) => void;
  onForward: (message: ChatMessage) => void;
  onJumpTo: (messageId: number) => void;
  onEditEnd: () => void;
}) {
  return groupByDay(messages).map((group) => (
    // One wrapper per calendar day: a sticky element only stays
    // pinned while its parent is on screen, so scoping each
    // separator to its own day makes it get pushed out by the
    // next day's separator instead of piling up behind it.
    <div key={group[0]!.message.id} className="flex flex-col gap-2">
      {group.map(({ message, i }) => {
        const isOwn = message.senderId === me.id;
        const sender = chat.participants.find(
          (p) => p.userId === message.senderId,
        );
        // Null for a normal message, and also once the quoted
        // message has been deleted — nothing to jump to either way.
        const parentId = message.parentMessage?.id;
        const isFirstOfDay = group[0]!.i === i;
        return (
          <Fragment key={message.id}>
            {isFirstOfDay && <DateSeparator ms={message.createdAt} />}
            <MessageBubble
              message={message}
              isOwn={isOwn}
              isRead={message.readByUserIds.length > 0}
              canModify={isOwn || me.role === "admin"}
              canDeleteOthers={!isOwn && canManage}
              onEdit={(content) => onEdit(message.id, content)}
              onDelete={() => onDelete(message.id)}
              onReply={() =>
                onReply({
                  id: message.id,
                  senderName: sender ? userLabel(sender) : "Someone",
                  contentType: message.contentType,
                  content: message.content,
                  caption: message.caption,
                })
              }
              onForward={() => onForward(message)}
              onJumpToParent={
                parentId == null ? undefined : () => onJumpTo(parentId)
              }
              highlightKey={
                jumpHighlight?.messageId === message.id
                  ? jumpHighlight.key
                  : undefined
              }
              editRequestKey={
                editRequest?.messageId === message.id
                  ? editRequest.key
                  : undefined
              }
              onEditEnd={onEditEnd}
              readOnly={chat.messageRequest != null}
              compact={compact}
              animateIn={!wasShownBeforeConfirm(message)}
              senderLabel={
                chat.type === "group" && sender ? userLabel(sender) : undefined
              }
              senderHandle={
                chat.type === "group" && sender ? userHandle(sender) : undefined
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
              style={
                {
                  "--stagger-index": Math.min(i, 6),
                } as CSSProperties
              }
            />
          </Fragment>
        );
      })}
    </div>
  ));
}

// "X is typing…" under the messages. Its own component, subscribed to the
// typing store on its own, so a typing ping re-renders just this bubble —
// not the whole chat view and every message in it.
export function TypingIndicator({
  chatId,
  meId,
  showNames,
}: {
  chatId: number;
  meId: number;
  showNames: boolean;
}) {
  const typingUsers = useTypingUsers(chatId).filter((t) => t.userId !== meId);
  if (typingUsers.length === 0) return null;
  return (
    <div className="flex w-full justify-start motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-2 motion-safe:duration-300">
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm border border-border bg-card px-3.5 py-2.5 text-muted-foreground shadow-sm">
        <TypingDots />
        {showNames && (
          <span className="text-xs">
            {typingUsers.map((t) => userLabel(t)).join(", ")}{" "}
            {typingUsers.length === 1 ? "is" : "are"} typing…
          </span>
        )}
      </div>
    </div>
  );
}
