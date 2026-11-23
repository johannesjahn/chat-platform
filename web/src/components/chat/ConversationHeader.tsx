import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Info,
  PanelRight,
  Settings2,
  Users,
  UserX,
} from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { PresenceDot } from "@/components/PresenceDot";
import { UserStatusBadge } from "@/components/UserStatusBadge";
import { Button } from "@/components/ui/button";
import { CardHeader } from "@/components/ui/card";
import { setChatDetailsOpen } from "@/lib/chatDetails";
import {
  type Chat,
  chatViewTransitionNames,
  isDirectChatWithDeletedAccount,
} from "@/lib/chats";
import { isStatusVisible, type UserStatus } from "@/lib/status";
import { userHandle } from "@/lib/users";

// The conversation's own header, shared with the loading skeleton so the two
// are the same height and opening a chat doesn't shift the thread.
//
// It owns `env(safe-area-inset-top)` below `lg`, where the immersive shell
// hides the site nav (see styles.css) and this becomes the topmost chrome on
// screen — `viewport-fit=cover` lets the page run under the status bar, so
// something has to put a background there or the clock sits on the messages.
// At `lg` it's exactly as tall as the chat list pane's header beside it
// (issue #554), so the two read as one bar across the messenger.
export const CHAT_HEADER_CLASS =
  "flex shrink-0 flex-row items-center gap-3 border-b border-border pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] lg:h-16 lg:py-0";

/**
 * The page conversation's header (a docked window draws its own compact
 * one): back, the other person — or the group — and chat details: the
 * side panel's toggle at `xl`+, a button opening the same details as a sheet
 * below it (issue #907), beside a group's "Manage". Split out
 * of ChatConversation in issue #811; the presence/status hooks stay there,
 * since they run for a docked conversation too.
 */
export function ConversationHeader({
  chat,
  name,
  otherParticipant,
  otherParticipantOnline,
  otherParticipantStatus,
  detailsAsPanel,
  detailsOpen,
  onOpenDetails,
  onOpenDetailsSheet,
}: {
  chat: Chat;
  name: string;
  otherParticipant: Chat["participants"][number] | undefined;
  otherParticipantOnline: boolean;
  otherParticipantStatus: UserStatus | undefined;
  detailsAsPanel: boolean;
  detailsOpen: boolean;
  onOpenDetails: () => void;
  onOpenDetailsSheet: () => void;
}) {
  const otherParticipantId = otherParticipant?.userId;
  // Shared with the chat list's row for this chat, so opening a conversation
  // morphs its avatar and title into the header instead of the two screens
  // simply cross-fading (see chatViewTransitionNames / router.tsx).
  const transitionNames = chatViewTransitionNames(chat.id);
  const deletedPartner = isDirectChatWithDeletedAccount(chat);
  return (
    <CardHeader className={CHAT_HEADER_CLASS}>
      {/* Beside the desktop chat list there's nothing to go back to. */}
      <Button
        asChild
        size="icon"
        variant="ghost"
        aria-label="Back to chats"
        className="lg:hidden"
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
            {/* A gradient halo turning slowly behind an avatar whose
                owner is online — the same "live" language as the
                presence dot, at a size you notice without looking for
                it. Purely decorative and sized off the avatar, so it
                never affects layout. */}
            {otherParticipantOnline && (
              <span
                aria-hidden
                className="pointer-events-none absolute -inset-0.5 rounded-full opacity-70 blur-[1px] motion-safe:animate-avatar-ring"
                style={{
                  background:
                    "conic-gradient(from 0deg, oklch(0.72 0.16 150 / 0.9), oklch(0.62 0.19 277 / 0.5), transparent 60%, oklch(0.72 0.16 150 / 0.9))",
                }}
              />
            )}
            <Avatar
              name={name}
              avatarUrl={otherParticipant?.avatarUrl}
              avatarVariants={otherParticipant?.avatarVariants}
              // The other half of the shared-element view transition out
              // of the chat list — the row's avatar travels here rather
              // than the two screens cross-fading past each other.
              style={{ viewTransitionName: transitionNames.avatar }}
            />
            <PresenceDot
              online={otherParticipantOnline}
              className="absolute -bottom-0.5 -right-0.5"
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span
              className="truncate font-semibold"
              style={{ viewTransitionName: transitionNames.title }}
            >
              {name}
            </span>
            <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              {otherParticipant && userHandle(otherParticipant) && (
                <>
                  <span className="truncate">
                    {userHandle(otherParticipant)}
                  </span>
                  <span className="shrink-0">·</span>
                </>
              )}
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
          onClick={onOpenDetails}
          className="group/hdr flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-accent/50"
        >
          {chat.avatarVariants ? (
            <Avatar
              name={name}
              avatarVariants={chat.avatarVariants}
              className="shrink-0 transition-transform motion-safe:group-hover/hdr:scale-105"
              style={{ viewTransitionName: transitionNames.avatar }}
            />
          ) : (
            <div
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground transition-transform motion-safe:group-hover/hdr:scale-105"
              style={{ viewTransitionName: transitionNames.avatar }}
            >
              {deletedPartner ? (
                <UserX className="size-4" />
              ) : (
                <Users className="size-4" />
              )}
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span
              className="truncate font-semibold"
              style={{ viewTransitionName: transitionNames.title }}
            >
              {name}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {deletedPartner ? (
                "This account was deleted"
              ) : (
                <>
                  {chat.participants.length} participant
                  {chat.participants.length === 1 ? "" : "s"}
                </>
              )}
            </span>
          </div>
        </button>
      )}

      {detailsAsPanel ? (
        <Button
          size="icon"
          variant={detailsOpen ? "secondary" : "ghost"}
          aria-label="Chat details"
          title="Chat details"
          aria-pressed={detailsOpen}
          onClick={() => setChatDetailsOpen(!detailsOpen)}
        >
          <PanelRight className="size-4" />
        </Button>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Chat details"
            title="Chat details"
            onClick={onOpenDetailsSheet}
          >
            <Info className="size-4" />
          </Button>
          {chat.type === "group" && (
            <Button
              variant="outline"
              size="sm"
              aria-label="Manage group"
              onClick={onOpenDetails}
            >
              <Settings2 className="size-4" />
              <span className="hidden sm:inline">Manage</span>
            </Button>
          )}
        </div>
      )}
    </CardHeader>
  );
}
