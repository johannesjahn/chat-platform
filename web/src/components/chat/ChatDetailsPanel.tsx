import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  FileText,
  Images,
  Pin,
  ShieldBan,
  Star,
  UserRound,
  X,
} from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { BlockUserControls } from "@/components/BlockUserControls";
import { DetailsSection } from "@/components/chat/DetailsSection";
import {
  GroupIdentity,
  GroupSettingsSections,
} from "@/components/GroupManagementDialog";
import { PresenceDot } from "@/components/PresenceDot";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserStatusBadge } from "@/components/UserStatusBadge";
import type { Session } from "@/lib/api";
import { attachmentKind, formatBytes } from "@/lib/attachments";
import { requestJumpToMessage, setChatDetailsOpen } from "@/lib/chatDetails";
import {
  messagePreview,
  useCachedChatMessages,
  usePinnedMessages,
  useStarredMessages,
  useChatDetail,
  type Chat,
  type ChatMessage,
  type ChatParticipant,
} from "@/lib/chats";
import { useIsOnline } from "@/lib/presence";
import { useUserStatus } from "@/lib/status";
import { userAvatarName, userHandle, userLabel } from "@/lib/users";

// How many of the newest shared images/files the panel lists.
const MAX_SHARED_MEDIA = 12;
const MAX_SHARED_FILES = 8;

/**
 * The desktop chat details panel (issue #563): the third pane of the chats
 * layout at `xl`+, beside the open conversation, toggled from its header.
 *
 * A group gets what the group settings modal holds — the same
 * `GroupSettingsSections`, not a second copy. A direct chat gets the other
 * person and block/mute. Both get pinned and starred messages and the media
 * shared in the loaded part of the thread; picking one scrolls the thread to
 * it.
 *
 * It stays mounted while you switch chats (so it doesn't slide in afresh
 * each time); its contents are keyed by chat, so local state — a half-typed
 * rename, an open "add people" search — doesn't follow you to another one.
 */
export function ChatDetailsPanel({
  chatId,
  currentUser,
}: {
  chatId: number;
  currentUser: Session["user"];
}) {
  const { data: chat, error } = useChatDetail(chatId, true);

  return (
    <aside
      aria-label="Chat details"
      className="flex w-80 shrink-0 flex-col border-l border-border bg-card/40 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-4 motion-safe:duration-300 2xl:w-96"
    >
      {/* As tall as the conversation's header beside it, so the two read as
          one bar. */}
      <div className="flex h-16 shrink-0 items-center gap-2 border-b border-border px-4">
        <h2 className="text-base font-semibold tracking-tight">
          {chat?.type === "group" ? "Group details" : "Details"}
        </h2>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Close chat details"
          className="ml-auto"
          onClick={() => setChatDetailsOpen(false)}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-4 py-5">
        {!chat && error ? (
          <p className="text-sm text-muted-foreground">
            Details for this chat aren&apos;t available.
          </p>
        ) : !chat ? (
          <div className="flex items-center gap-3" aria-busy="true">
            <Skeleton className="size-14 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ) : (
          <ChatDetails key={chat.id} chat={chat} currentUser={currentUser} />
        )}
      </div>
    </aside>
  );
}

function ChatDetails({
  chat,
  currentUser,
}: {
  chat: Chat;
  currentUser: Session["user"];
}) {
  const other =
    chat.type === "direct"
      ? chat.participants.find((p) => p.userId !== currentUser.id)
      : undefined;

  return (
    <>
      {chat.type === "group" ? (
        <GroupIdentity chat={chat} />
      ) : (
        other && <DirectChatPerson participant={other} />
      )}
      <PinnedSection chat={chat} />
      <StarredSection chat={chat} />
      <SharedMediaSection chatId={chat.id} />
      {chat.type === "group" ? (
        <GroupSettingsSections
          chat={chat}
          currentUser={currentUser}
          onLeft={() => setChatDetailsOpen(false)}
        />
      ) : (
        other && <PrivacySection userId={other.userId} />
      )}
    </>
  );
}

// The other person in a direct chat: who they are, whether they're around,
// and a way to their full profile.
function DirectChatPerson({ participant }: { participant: ChatParticipant }) {
  const online = useIsOnline(participant.userId);
  const status = useUserStatus(participant.userId, participant);
  const handle = userHandle(participant);

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="relative">
        <Avatar
          name={userAvatarName(participant)}
          avatarUrl={participant.avatarUrl}
          avatarVariants={participant.avatarVariants}
          size="xl"
        />
        <PresenceDot
          online={online}
          className="absolute right-0.5 bottom-0.5"
        />
      </div>
      <div className="flex min-w-0 max-w-full flex-col leading-tight">
        <span className="truncate text-lg font-semibold">
          {userLabel(participant)}
        </span>
        {handle && (
          <span className="truncate text-sm text-muted-foreground">
            {handle}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {online ? "Online" : "Offline"}
        </span>
      </div>
      <UserStatusBadge status={status} className="text-sm" />
      <Button asChild variant="outline" size="sm">
        <Link to="/users/$id" params={{ id: String(participant.userId) }}>
          <UserRound className="size-4" />
          View profile
        </Link>
      </Button>
    </div>
  );
}

function PrivacySection({ userId }: { userId: number }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <DetailsSection
      index={3}
      icon={<ShieldBan className="size-4" />}
      title="Privacy"
      description="Muting hides their posts and notifications. Blocking also stops direct messages both ways."
    >
      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <BlockUserControls userId={userId} onError={setError} />
    </DetailsSection>
  );
}

function PinnedSection({ chat }: { chat: Chat }) {
  const { data: pinned, isLoading } = usePinnedMessages(chat.id, true);
  return (
    <DetailsSection
      index={0}
      icon={<Pin className="size-4" />}
      title={pinned?.length ? `Pinned · ${pinned.length}` : "Pinned"}
      description="Pinned for everyone in this chat."
    >
      <MessageList
        chat={chat}
        messages={pinned}
        loading={isLoading}
        empty="Nothing pinned yet."
      />
    </DetailsSection>
  );
}

function StarredSection({ chat }: { chat: Chat }) {
  const { data: starred, isLoading } = useStarredMessages(chat.id, true);
  return (
    <DetailsSection
      index={1}
      icon={<Star className="size-4" />}
      title={starred?.length ? `Starred · ${starred.length}` : "Starred"}
      description="Only you can see what you've starred."
    >
      <MessageList
        chat={chat}
        messages={starred}
        loading={isLoading}
        empty="Star a message to keep it handy here."
      />
    </DetailsSection>
  );
}

function MessageList({
  chat,
  messages,
  loading,
  empty,
}: {
  chat: Chat;
  messages: ChatMessage[] | undefined;
  loading: boolean;
  empty: string;
}) {
  if (loading) return <Skeleton className="h-10 w-full rounded-xl" />;
  if (!messages || messages.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
        {empty}
      </p>
    );
  }
  const senderName = (senderId: number) => {
    const sender = chat.participants.find((p) => p.userId === senderId);
    return sender ? userLabel(sender) : "Someone";
  };
  return (
    <ul className="flex flex-col gap-1">
      {messages.map((message) => (
        <li key={message.id}>
          <button
            type="button"
            onClick={() => requestJumpToMessage(chat.id, message.id)}
            className="flex w-full flex-col items-start rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
          >
            <span className="text-xs font-semibold text-primary">
              {senderName(message.senderId)}
            </span>
            <span className="line-clamp-2 w-full break-words text-xs text-muted-foreground">
              {messagePreview(message)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// Images and files shared in the part of the conversation that's loaded —
// there's no endpoint listing a chat's attachments, so scrolling further
// back in the thread is what brings older ones in. Read straight from the
// conversation's message cache rather than fetching a second window of it.
function SharedMediaSection({ chatId }: { chatId: number }) {
  const data = useCachedChatMessages(chatId);
  const newestFirst = [...(data?.messages ?? [])].reverse();
  const images = newestFirst
    .flatMap((message) => {
      if (message.contentType === "image_url") {
        return [{ message, src: message.content, alt: "" }];
      }
      if (
        message.attachment &&
        attachmentKind(message.attachment.mimeType) === "image"
      ) {
        return [
          {
            message,
            src: message.attachment.url,
            alt: message.attachment.filename,
          },
        ];
      }
      return [];
    })
    .slice(0, MAX_SHARED_MEDIA);
  const files = newestFirst
    .flatMap((message) =>
      message.attachment &&
      attachmentKind(message.attachment.mimeType) !== "image"
        ? [message.attachment]
        : [],
    )
    .slice(0, MAX_SHARED_FILES);

  return (
    <DetailsSection
      index={2}
      icon={<Images className="size-4" />}
      title="Shared media"
      description="Photos and files from the loaded conversation."
    >
      {images.length === 0 && files.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          No photos or files yet.
        </p>
      ) : (
        <>
          {images.length > 0 && (
            <ul className="grid grid-cols-3 gap-1.5">
              {images.map(({ message, src, alt }) => (
                <li key={message.id}>
                  <button
                    type="button"
                    aria-label={
                      alt ? `Show ${alt} in chat` : "Show photo in chat"
                    }
                    onClick={() => requestJumpToMessage(chatId, message.id)}
                    className="block aspect-square w-full overflow-hidden rounded-lg bg-muted transition-opacity hover:opacity-85"
                  >
                    <img
                      src={src}
                      alt=""
                      loading="lazy"
                      className="size-full object-cover"
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {files.length > 0 && (
            <ul className="flex flex-col gap-1">
              {files.map((file) => (
                <li key={file.id}>
                  <a
                    href={file.url}
                    target="_blank"
                    rel="noreferrer"
                    download={file.filename}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-accent/50"
                  >
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {file.filename}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatBytes(file.size)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </DetailsSection>
  );
}
