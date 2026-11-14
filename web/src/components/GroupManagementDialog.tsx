import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
  Check,
  ImageUp,
  Loader2,
  LogOut,
  Pencil,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { AvatarCropDialog } from "@/components/AvatarCropDialog";
import { Button } from "@/components/ui/button";
import { DetailsSection as Section } from "@/components/chat/DetailsSection";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/attachments";
import { $api, type Session } from "@/lib/api";
import {
  isAllowedAvatarFile,
  MAX_AVATAR_UPLOAD_SIZE_BYTES,
  uploadChatAvatar,
} from "@/lib/avatar";
import { chatDetailQueryKey, chatsListQueryKey, type Chat } from "@/lib/chats";
import { canManageChat, canManageChatRoles, chatRoleOf } from "@/lib/chatRoles";
import { errorMessage } from "@/lib/errors";
import { userLabel } from "@/lib/users";
import { AddParticipantsPanel } from "@/components/chat/group/AddParticipantsPanel";
import { InviteLinksSection } from "@/components/chat/group/InviteLinksSection";
import { ParticipantRow } from "@/components/chat/group/ParticipantRow";

type GroupManagementDialogProps = {
  chat: Chat;
  currentUser: Session["user"];
  open: boolean;
  onClose: () => void;
};

// A single, roomy, animated home for everything you can do to a group chat —
// rename it, manage members and their roles, share invite links, and leave or
// delete it. It replaces the old cluster of cryptic icon-only buttons and
// cramped inline panels with clearly-labelled, self-explanatory sections.
//
// Self-contained on purpose: it owns its own mutations, queries, and local
// UI state so the chat view only has to say "open" / "closed", keeping that
// already-large component lean.
export function GroupManagementDialog({
  chat,
  currentUser,
  open,
  onClose,
}: GroupManagementDialogProps) {
  // Close on Escape and lock background scroll while open. The hook runs every
  // render (bailing out when closed) so hook order stays stable across the
  // `open` toggle below.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  // Portalled to <body>: rendered in place it would sit inside the
  // conversation's subtree, where an ancestor's transform or stacking context
  // can clip it or paint the blurred chat header and composer over it.
  return createPortal(
    <div
      className="overlay-viewport z-50 flex items-end justify-center pt-[env(safe-area-inset-top)] sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Group settings"
    >
      <div
        className="absolute inset-0 bg-background/70 backdrop-blur-sm motion-safe:animate-backdrop-blur-in"
        onClick={onClose}
      />
      {/* The panel springs up out of a blur while the backdrop above ramps
          its own blur on — the two together read as the page receding rather
          than a card being pasted over it. */}
      <div className="relative flex max-h-[92%] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-border bg-card shadow-2xl motion-safe:animate-dialog-in sm:rounded-3xl">
        <GroupManagementBody
          chat={chat}
          currentUser={currentUser}
          onClose={onClose}
        />
      </div>
    </div>,
    document.body,
  );
}

// Split out so the heavy hooks in the sections only run while the dialog is
// actually mounted (the wrapper returns null when closed), and so each open
// starts from clean local state.
function GroupManagementBody({
  chat,
  currentUser,
  onClose,
}: {
  chat: Chat;
  currentUser: Session["user"];
  onClose: () => void;
}) {
  return (
    <>
      {/* Header — big group identity, participant count, close. */}
      <div className="flex items-center gap-3 border-b border-border bg-gradient-to-b from-accent/40 to-transparent px-5 py-5">
        <GroupIdentity chat={chat} />
        <Button
          size="icon"
          variant="ghost"
          aria-label="Close group settings"
          onClick={onClose}
        >
          <X className="size-5" />
        </Button>
      </div>

      {/* On a phone the sheet runs to the bottom edge, so its last section
          is kept clear of the home indicator. */}
      <div className="flex flex-col gap-6 overflow-y-auto px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:pb-5">
        <GroupSettingsSections
          chat={chat}
          currentUser={currentUser}
          onLeft={onClose}
        />
      </div>
    </>
  );
}

// The group's avatar, name and member count — the top of both the modal and
// the desktop details panel.
export function GroupIdentity({ chat }: { chat: Chat }) {
  const title = chat.title ?? "Group chat";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      {chat.avatarVariants ? (
        <Avatar
          name={title}
          avatarVariants={chat.avatarVariants}
          size="xl"
          className="size-14"
        />
      ) : (
        <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/20">
          <Users className="size-7" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-lg font-semibold leading-tight">
          {title}
        </span>
        <span className="text-sm text-muted-foreground">
          {chat.participants.length} member
          {chat.participants.length === 1 ? "" : "s"} · Group chat
        </span>
      </div>
    </div>
  );
}

/**
 * Everything you can do to a group chat, as stacked sections: avatar, name,
 * members and roles, invite links, leave or delete. Rendered by the modal
 * (below `xl`) and by the desktop chat details panel (issue #563), so there's
 * one copy of it. Expects a parent that lays its children out with a gap.
 *
 * `onLeft` runs once you've left or deleted the chat, just before navigating
 * back to `/chats`.
 */
export function GroupSettingsSections({
  chat,
  currentUser,
  onLeft,
}: {
  chat: Chat;
  currentUser: Session["user"];
  onLeft?: () => void;
}) {
  const chatId = chat.id;
  const queryClient = useQueryClient();
  const router = useRouter();

  const updateChat = $api.useMutation("put", "/chats/{id}");
  const deleteChatAvatar = $api.useMutation("delete", "/chats/{id}/avatar");
  const removeParticipant = $api.useMutation(
    "delete",
    "/chats/{id}/participants/{userId}",
  );
  const leaveChat = $api.useMutation("post", "/chats/{id}/leave");
  const confirm = useConfirm();
  const deleteChat = $api.useMutation("delete", "/chats/{id}");
  const transferOwnership = $api.useMutation("post", "/chats/{id}/owner");
  const updateParticipantRole = $api.useMutation(
    "patch",
    "/chats/{id}/participants/{userId}/role",
  );

  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [avatarCropFile, setAvatarCropFile] = useState<File | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement>(null);

  const myRole = chatRoleOf(chat, currentUser.id);
  const canManage = canManageChat(chat, currentUser);
  const canManageRoles = canManageChatRoles(chat, currentUser);
  const canClaimOwnership = chat.createdBy === null;

  async function invalidateChat() {
    await queryClient.invalidateQueries({
      queryKey: chatDetailQueryKey(chatId),
    });
  }

  async function handleRenameSubmit() {
    const title = titleDraft.trim();
    if (!title) return;
    setActionError(null);
    try {
      await updateChat.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: { title },
      });
      await invalidateChat();
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      setRenaming(false);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleRemoveAvatar() {
    setActionError(null);
    try {
      await deleteChatAvatar.mutateAsync({
        params: { path: { id: String(chatId) } },
      });
      await invalidateChat();
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleRemoveParticipant(userId: number, label: string) {
    const ok = await confirm({
      title: `Remove ${label} from this chat?`,
      description:
        "They'll lose access to the conversation. You can add them back later.",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    setActionError(null);
    try {
      await removeParticipant.mutateAsync({
        params: { path: { id: String(chatId), userId: String(userId) } },
      });
      await invalidateChat();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleTransferOwnership(userId: number, label: string) {
    const ok = await confirm({
      title: `Make ${label} the owner of this chat?`,
      description:
        "They'll be able to manage members, settings, and delete the chat. Only they can hand ownership back.",
      confirmLabel: "Transfer ownership",
      destructive: false,
    });
    if (!ok) return;
    setActionError(null);
    try {
      await transferOwnership.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: { userId },
      });
      await invalidateChat();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleUpdateParticipantRole(
    userId: number,
    role: "admin" | "member",
  ) {
    setActionError(null);
    try {
      await updateParticipantRole.mutateAsync({
        params: { path: { id: String(chatId), userId: String(userId) } },
        body: { role },
      });
      await invalidateChat();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleLeave() {
    const ok = await confirm({
      title: "Leave this chat?",
      description:
        "You'll stop receiving its messages. Someone in the chat will need to add you back.",
      confirmLabel: "Leave chat",
    });
    if (!ok) return;
    setActionError(null);
    try {
      await leaveChat.mutateAsync({ params: { path: { id: String(chatId) } } });
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      onLeft?.();
      await router.navigate({ to: "/chats" });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: "Delete this chat for everyone?",
      description:
        "All of its messages and attachments are removed for every member. This can't be undone.",
      confirmLabel: "Delete chat",
    });
    if (!ok) return;
    setActionError(null);
    try {
      await deleteChat.mutateAsync({
        params: { path: { id: String(chatId) } },
      });
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      onLeft?.();
      await router.navigate({ to: "/chats" });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  const title = chat.title ?? "Group chat";

  return (
    <>
      {actionError && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive motion-safe:animate-in motion-safe:fade-in-0">
          {actionError}
        </p>
      )}

      {avatarCropFile && (
        <AvatarCropDialog
          file={avatarCropFile}
          onClose={() => setAvatarCropFile(null)}
          upload={(file, crop) => uploadChatAvatar(chatId, file, crop)}
          onUploaded={async () => {
            setAvatarCropFile(null);
            await invalidateChat();
            await queryClient.invalidateQueries({
              queryKey: chatsListQueryKey,
            });
          }}
        />
      )}

      {/* Group avatar */}
      <Section
        index={0}
        icon={<ImageUp className="size-4" />}
        title="Group avatar"
        description={
          canManage
            ? "Shown wherever this group appears — the chat list, headers, and mentions."
            : "Shown wherever this group appears."
        }
      >
        <div className="flex items-center gap-4">
          <Avatar name={title} avatarVariants={chat.avatarVariants} size="xl" />
          {canManage && (
            <div className="flex flex-1 flex-col gap-2">
              <input
                ref={avatarFileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  setActionError(null);
                  if (!isAllowedAvatarFile(file)) {
                    setActionError(
                      "Avatars must be a JPEG, PNG, or WebP image.",
                    );
                    return;
                  }
                  if (file.size > MAX_AVATAR_UPLOAD_SIZE_BYTES) {
                    setActionError(
                      `File exceeds the ${formatBytes(MAX_AVATAR_UPLOAD_SIZE_BYTES)} limit`,
                    );
                    return;
                  }
                  setAvatarCropFile(file);
                }}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => avatarFileInputRef.current?.click()}
                >
                  <ImageUp className="size-4" />
                  Upload photo
                </Button>
                {chat.avatarVariants && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start text-destructive hover:text-destructive"
                    disabled={deleteChatAvatar.isPending}
                    onClick={() => void handleRemoveAvatar()}
                  >
                    <Trash2 className="size-4" />
                    Remove
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* Group name */}
      <Section
        index={1}
        icon={<Pencil className="size-4" />}
        title="Group name"
        description="This is what everyone sees at the top of the conversation."
      >
        {renaming ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void handleRenameSubmit();
            }}
          >
            <Input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              maxLength={100}
              placeholder="Group name"
            />
            <Button
              type="submit"
              disabled={updateChat.isPending || !titleDraft.trim()}
            >
              {updateChat.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRenaming(false)}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background/60 px-3.5 py-2.5">
            <span className="truncate font-medium">{title}</span>
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                aria-label="Rename chat"
                onClick={() => {
                  setTitleDraft(chat.title ?? "");
                  setRenaming(true);
                }}
              >
                <Pencil className="size-3.5" />
                Rename
              </Button>
            )}
          </div>
        )}
      </Section>

      {/* Members */}
      <Section
        index={2}
        icon={<Users className="size-4" />}
        title={`Members · ${chat.participants.length}`}
        description={
          canManage
            ? "Promote members to admins, hand over ownership, or remove people."
            : "Everyone currently in this conversation."
        }
      >
        <ul className="flex flex-col gap-1.5">
          {chat.participants.map((p, i) => {
            const isOwner = chat.createdBy === p.userId;
            const isSelf = p.userId === currentUser.id;
            const label = userLabel(p);
            const canRemove =
              canManage &&
              !isSelf &&
              (!isOwner || myRole === "owner" || currentUser.role === "admin");
            return (
              <ParticipantRow
                key={p.userId}
                participant={p}
                index={i}
                isOwner={isOwner}
                isSelf={isSelf}
                label={label}
                canRemove={canRemove}
                canManageRoles={canManageRoles}
                canClaimOwnership={canClaimOwnership}
                updateRolePending={updateParticipantRole.isPending}
                transferOwnershipPending={transferOwnership.isPending}
                removePending={removeParticipant.isPending}
                onUpdateRole={(userId, role) =>
                  void handleUpdateParticipantRole(userId, role)
                }
                onTransferOwnership={(userId, label) =>
                  void handleTransferOwnership(userId, label)
                }
                onRemove={(userId, label) =>
                  void handleRemoveParticipant(userId, label)
                }
              />
            );
          })}
        </ul>

        <AddParticipantsPanel
          chat={chat}
          canManage={canManage}
          onError={setActionError}
          onAdded={invalidateChat}
        />
      </Section>

      {/* Invite links */}
      <InviteLinksSection
        chatId={chatId}
        canManage={canManage}
        onError={setActionError}
      />

      {/* Danger zone */}
      <Section
        index={4}
        icon={<LogOut className="size-4" />}
        title="Leave or delete"
        description="Leaving removes you from the chat. Deleting removes it for everyone."
      >
        <div className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 @sm:flex-row">
          <Button
            variant="outline"
            className="flex-1"
            disabled={leaveChat.isPending}
            onClick={() => void handleLeave()}
          >
            {leaveChat.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogOut className="size-4" />
            )}
            Leave chat
          </Button>
          {canManage && (
            <Button
              variant="destructive"
              className="flex-1"
              disabled={deleteChat.isPending}
              onClick={() => void handleDelete()}
            >
              {deleteChat.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete chat
            </Button>
          )}
        </div>
      </Section>
    </>
  );
}
