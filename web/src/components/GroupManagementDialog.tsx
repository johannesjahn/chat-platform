import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
  Check,
  Copy,
  Crown,
  Link2,
  Loader2,
  LogOut,
  Pencil,
  Search,
  Shield,
  ShieldOff,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { $api, MIN_USER_SEARCH_QUERY_LENGTH } from "@/lib/api";
import type { Session } from "@/lib/api";
import {
  MAX_GROUP_PARTICIPANTS,
  chatDetailQueryKey,
  chatsListQueryKey,
  type Chat,
} from "@/lib/chats";
import { errorMessage } from "@/lib/errors";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { userAvatarName, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Group settings"
    >
      <div
        className="absolute inset-0 bg-background/70 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
        onClick={onClose}
      />
      <div className="relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-border bg-card shadow-2xl ease-spring motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:slide-in-from-bottom-4 motion-safe:duration-300 sm:rounded-3xl">
        <GroupManagementBody
          chat={chat}
          currentUser={currentUser}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

// Split out so the heavy hooks below only run while the dialog is actually
// mounted (the wrapper returns null when closed), and so each open starts
// from clean local state.
function GroupManagementBody({
  chat,
  currentUser,
  onClose,
}: {
  chat: Chat;
  currentUser: Session["user"];
  onClose: () => void;
}) {
  const chatId = chat.id;
  const queryClient = useQueryClient();
  const router = useRouter();

  const updateChat = $api.useMutation("put", "/chats/{id}");
  const addParticipants = $api.useMutation("post", "/chats/{id}/participants");
  const removeParticipant = $api.useMutation(
    "delete",
    "/chats/{id}/participants/{userId}",
  );
  const leaveChat = $api.useMutation("post", "/chats/{id}/leave");
  const deleteChat = $api.useMutation("delete", "/chats/{id}");
  const transferOwnership = $api.useMutation("post", "/chats/{id}/owner");
  const updateParticipantRole = $api.useMutation(
    "patch",
    "/chats/{id}/participants/{userId}/role",
  );
  const createInvite = $api.useMutation("post", "/chats/{id}/invites");
  const revokeInvite = $api.useMutation(
    "delete",
    "/chats/{id}/invites/{inviteId}",
  );
  const {
    data: invites,
    isLoading: invitesLoading,
    refetch: refetchInvites,
  } = $api.useQuery("get", "/chats/{id}/invites", {
    params: { path: { id: String(chatId) } },
  });

  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [addingParticipants, setAddingParticipants] = useState(false);
  const [addParticipantsSearch, setAddParticipantsSearch] = useState("");
  const [selectedToAdd, setSelectedToAdd] = useState<number[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<number | null>(null);
  // Captured once on open so the render stays pure — good enough for showing
  // whether an invite has lapsed; it refreshes each time the dialog reopens.
  const [now] = useState(() => Date.now());

  const addParticipantsQuery = useDebouncedValue(
    addParticipantsSearch.trim(),
    300,
  );
  const addParticipantsSearchReady =
    addParticipantsQuery.length >= MIN_USER_SEARCH_QUERY_LENGTH;
  const { data: userSearchResults, isLoading: userSearchLoading } =
    $api.useQuery(
      "get",
      "/users/search",
      { params: { query: { q: addParticipantsQuery } } },
      { enabled: addingParticipants && addParticipantsSearchReady },
    );

  const myRole = chat.participants.find(
    (p) => p.userId === currentUser.id,
  )?.role;
  const canManage =
    myRole === "owner" || myRole === "admin" || currentUser.role === "admin";
  const canManageRoles = myRole === "owner" || currentUser.role === "admin";
  const canClaimOwnership = chat.createdBy === null;
  const canAddMore = chat.participants.length < MAX_GROUP_PARTICIPANTS;
  const candidatesToAdd = (userSearchResults ?? []).filter(
    (u) => !chat.participants.some((p) => p.userId === u.id),
  );

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

  async function handleAddParticipants() {
    if (selectedToAdd.length === 0) return;
    setActionError(null);
    try {
      await addParticipants.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: { participantIds: selectedToAdd },
      });
      await invalidateChat();
      setSelectedToAdd([]);
      setAddingParticipants(false);
      setAddParticipantsSearch("");
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleRemoveParticipant(userId: number, label: string) {
    if (!window.confirm(`Remove ${label} from this chat?`)) return;
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
    if (!window.confirm(`Make ${label} the owner of this chat?`)) return;
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

  async function handleCreateInvite() {
    setActionError(null);
    try {
      await createInvite.mutateAsync({
        params: { path: { id: String(chatId) } },
        body: {},
      });
      await refetchInvites();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleRevokeInvite(inviteId: number) {
    setActionError(null);
    try {
      await revokeInvite.mutateAsync({
        params: { path: { id: String(chatId), inviteId: String(inviteId) } },
      });
      await refetchInvites();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleCopyInviteLink(inviteId: number, code: string) {
    const url = `${window.location.origin}/chats/join/${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedInviteId(inviteId);
      setTimeout(
        () => setCopiedInviteId((prev) => (prev === inviteId ? null : prev)),
        2000,
      );
    } catch {
      setActionError("Couldn't copy the link — copy it manually.");
    }
  }

  async function handleLeave() {
    if (!window.confirm("Leave this chat?")) return;
    setActionError(null);
    try {
      await leaveChat.mutateAsync({ params: { path: { id: String(chatId) } } });
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      onClose();
      await router.navigate({ to: "/chats" });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this chat for everyone? This can't be undone."))
      return;
    setActionError(null);
    try {
      await deleteChat.mutateAsync({
        params: { path: { id: String(chatId) } },
      });
      await queryClient.invalidateQueries({ queryKey: chatsListQueryKey });
      onClose();
      await router.navigate({ to: "/chats" });
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  const title = chat.title ?? "Group chat";
  const activeInvites = (invites ?? []).filter((i) => i.revokedAt === null);

  return (
    <>
      {/* Header — big group identity, participant count, close. */}
      <div className="flex items-center gap-3 border-b border-border bg-gradient-to-b from-accent/40 to-transparent px-5 py-5">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/20">
          <Users className="size-7" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-lg font-semibold leading-tight">
            {title}
          </span>
          <span className="text-sm text-muted-foreground">
            {chat.participants.length} member
            {chat.participants.length === 1 ? "" : "s"} · Group chat
          </span>
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Close group settings"
          onClick={onClose}
        >
          <X className="size-5" />
        </Button>
      </div>

      <div className="flex flex-col gap-6 overflow-y-auto px-5 py-5">
        {actionError && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive motion-safe:animate-in motion-safe:fade-in-0">
            {actionError}
          </p>
        )}

        {/* Group name */}
        <Section
          index={0}
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
          index={1}
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
                (!isOwner ||
                  myRole === "owner" ||
                  currentUser.role === "admin");
              return (
                <li
                  key={p.userId}
                  className="flex items-center gap-3 rounded-xl border border-transparent px-2 py-2 transition-colors hover:border-border hover:bg-accent/30 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-1"
                  style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                >
                  <Avatar
                    name={userAvatarName(p)}
                    avatarUrl={p.avatarUrl}
                    avatarVariants={p.avatarVariants}
                    size="md"
                  />
                  <div className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-sm font-medium">
                      {label}
                      {isSelf && (
                        <span className="text-muted-foreground"> (you)</span>
                      )}
                    </span>
                    <RoleBadge isOwner={isOwner} role={p.role} />
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {canManageRoles && !isOwner && !isSelf && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2 text-xs"
                        aria-label={
                          p.role === "admin"
                            ? `Remove admin from ${label}`
                            : `Make ${label} an admin`
                        }
                        disabled={updateParticipantRole.isPending}
                        onClick={() =>
                          void handleUpdateParticipantRole(
                            p.userId,
                            p.role === "admin" ? "member" : "admin",
                          )
                        }
                      >
                        {p.role === "admin" ? (
                          <>
                            <ShieldOff className="size-3.5" />
                            <span className="hidden min-[420px]:inline">
                              Unadmin
                            </span>
                          </>
                        ) : (
                          <>
                            <Shield className="size-3.5" />
                            <span className="hidden min-[420px]:inline">
                              Make admin
                            </span>
                          </>
                        )}
                      </Button>
                    )}
                    {(canManageRoles || canClaimOwnership) && !isOwner && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 px-2 text-xs"
                        aria-label={`Make ${label} the owner`}
                        disabled={transferOwnership.isPending}
                        onClick={() =>
                          void handleTransferOwnership(p.userId, label)
                        }
                      >
                        <Crown className="size-3.5" />
                        <span className="hidden min-[420px]:inline">
                          Make owner
                        </span>
                      </Button>
                    )}
                    {canRemove && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 text-destructive hover:text-destructive"
                        aria-label={`Remove ${label}`}
                        disabled={removeParticipant.isPending}
                        onClick={() =>
                          void handleRemoveParticipant(p.userId, label)
                        }
                      >
                        <UserMinus className="size-4" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {canManage && (
            <div className="mt-1">
              {canAddMore ? (
                <Button
                  variant="outline"
                  className="w-full"
                  aria-label="Add participants"
                  onClick={() => {
                    setAddingParticipants((v) => !v);
                    setAddParticipantsSearch("");
                    setSelectedToAdd([]);
                  }}
                >
                  <UserPlus className="size-4" />
                  {addingParticipants ? "Cancel" : "Add people"}
                </Button>
              ) : (
                <p className="text-center text-xs text-muted-foreground">
                  This group is full ({MAX_GROUP_PARTICIPANTS} members).
                </p>
              )}

              {addingParticipants && canAddMore && (
                <div className="mt-3 flex flex-col gap-2 rounded-xl border border-border bg-background/60 p-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      autoFocus
                      value={addParticipantsSearch}
                      onChange={(e) => setAddParticipantsSearch(e.target.value)}
                      placeholder="Search users to add…"
                      className="pl-9"
                    />
                  </div>
                  {!addParticipantsSearchReady ? (
                    <p className="text-xs text-muted-foreground">
                      Type at least {MIN_USER_SEARCH_QUERY_LENGTH} characters to
                      search.
                    </p>
                  ) : userSearchLoading ? (
                    <p className="text-xs text-muted-foreground">Searching…</p>
                  ) : candidatesToAdd.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No matching users to add.
                    </p>
                  ) : (
                    <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
                      {candidatesToAdd.map((u) => {
                        const isSelected = selectedToAdd.includes(u.id);
                        return (
                          <button
                            key={u.id}
                            type="button"
                            onClick={() =>
                              setSelectedToAdd((prev) =>
                                isSelected
                                  ? prev.filter((id) => id !== u.id)
                                  : [...prev, u.id],
                              )
                            }
                            className={cn(
                              "rounded-full border px-3 py-1.5 text-xs transition-colors duration-200 motion-safe:hover:scale-[1.03]",
                              isSelected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-background/60 hover:border-primary/40",
                            )}
                          >
                            {userLabel(u)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <Button
                    className="self-end"
                    disabled={
                      selectedToAdd.length === 0 || addParticipants.isPending
                    }
                    onClick={() => void handleAddParticipants()}
                  >
                    {addParticipants.isPending && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    Add {selectedToAdd.length || ""}
                  </Button>
                </div>
              )}
            </div>
          )}
        </Section>

        {/* Invite links */}
        {canManage && (
          <Section
            index={2}
            icon={<Link2 className="size-4" />}
            title="Invite links"
            description="Anyone with an active link can join this chat — revoke a link to cut off access."
          >
            <div className="flex flex-col gap-2">
              {invitesLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : activeInvites.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                  No active invite links yet.
                </p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {activeInvites.map((invite) => {
                    const expired =
                      invite.expiresAt !== null && invite.expiresAt <= now;
                    const usedUp =
                      invite.maxUses !== null &&
                      invite.useCount >= invite.maxUses;
                    return (
                      <li
                        key={invite.id}
                        className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background/60 px-3 py-2"
                      >
                        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                          {invite.code.slice(0, 12)}…
                          {(expired || usedUp) && (
                            <span className="ml-1 text-destructive">
                              ({expired ? "expired" : "used up"})
                            </span>
                          )}
                          {invite.maxUses !== null &&
                            ` · ${invite.useCount}/${invite.maxUses} used`}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8"
                            aria-label="Copy invite link"
                            onClick={() =>
                              void handleCopyInviteLink(invite.id, invite.code)
                            }
                          >
                            {copiedInviteId === invite.id ? (
                              <Check className="size-4 text-green-600" />
                            ) : (
                              <Copy className="size-4" />
                            )}
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-8 text-destructive hover:text-destructive"
                            aria-label="Revoke invite link"
                            disabled={revokeInvite.isPending}
                            onClick={() => void handleRevokeInvite(invite.id)}
                          >
                            <X className="size-4" />
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <Button
                variant="outline"
                className="w-full"
                disabled={createInvite.isPending}
                onClick={() => void handleCreateInvite()}
              >
                {createInvite.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Link2 className="size-4" />
                )}
                Create invite link
              </Button>
            </div>
          </Section>
        )}

        {/* Danger zone */}
        <Section
          index={3}
          icon={<LogOut className="size-4" />}
          title="Leave or delete"
          description="Leaving removes you from the chat. Deleting removes it for everyone."
        >
          <div className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 sm:flex-row">
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
      </div>
    </>
  );
}

function RoleBadge({
  isOwner,
  role,
}: {
  isOwner: boolean;
  role: Chat["participants"][number]["role"];
}) {
  if (isOwner) {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
        <Crown className="size-3" />
        Owner
      </span>
    );
  }
  if (role === "admin") {
    return (
      <span className="flex items-center gap-1 text-xs text-primary">
        <Shield className="size-3" />
        Admin
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">Member</span>;
}

// A labelled, staggered-in block: an icon + heading + one-line explanation,
// then its controls. The explanation is what makes the panel self-explanatory
// rather than a wall of mystery icons.
function Section({
  index,
  icon,
  title,
  description,
  children,
}: {
  index: number;
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="flex flex-col gap-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          {icon}
        </div>
        <div className="flex flex-col">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
