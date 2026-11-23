import { Crown, Shield, ShieldOff, UserMinus } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import { UserStatusBadge } from "@/components/UserStatusBadge";
import { type Chat } from "@/lib/chats";
import { useUserStatus } from "@/lib/status";
import { userAvatarName, userHandle, userLabelWithHandle } from "@/lib/users";

type ParticipantRowProps = {
  participant: Chat["participants"][number];
  index: number;
  isOwner: boolean;
  isSelf: boolean;
  label: string;
  canRemove: boolean;
  canManageRoles: boolean;
  canClaimOwnership: boolean;
  updateRolePending: boolean;
  transferOwnershipPending: boolean;
  removePending: boolean;
  onUpdateRole: (userId: number, role: "admin" | "member") => void;
  onTransferOwnership: (userId: number, label: string) => void;
  onRemove: (userId: number, label: string) => void;
};

// Split out from the plain `.map()` body it used to be so `useUserStatus`
// (a hook) has a stable per-participant component instance to attach to —
// calling a hook a variable number of times inside a single `.map()`
// callback in the parent's own render would violate the rules of hooks
// whenever the member count changes (someone joins/leaves) between renders.
export function ParticipantRow({
  participant: p,
  index: i,
  isOwner,
  isSelf,
  label,
  canRemove,
  canManageRoles,
  canClaimOwnership,
  updateRolePending,
  transferOwnershipPending,
  removePending,
  onUpdateRole,
  onTransferOwnership,
  onRemove,
}: ParticipantRowProps) {
  const status = useUserStatus(p.userId, p);
  // Buttons and their confirm dialogs name exactly who they act on: display
  // names aren't unique (issue #526).
  const actionLabel = userLabelWithHandle(p);
  const canToggleAdmin = canManageRoles && !isOwner && !isSelf;
  const canMakeOwner = (canManageRoles || canClaimOwnership) && !isOwner;
  const hasActions = canToggleAdmin || canMakeOwner || canRemove;

  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-transparent px-2 py-2 transition-colors hover:border-border hover:bg-accent/30 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-1"
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
          {userHandle(p) && (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {userHandle(p)}
            </span>
          )}
          {isSelf && <span className="text-muted-foreground"> (you)</span>}
        </span>
        <RoleBadge isOwner={isOwner} role={p.role} />
        <UserStatusBadge
          status={status}
          className="text-xs text-muted-foreground"
        />
      </div>
      {/* Every action says what it does in words (issue #906): touch has no
          hover to tell a shield from a crown, and making someone the owner
          is too big a step to take by guessing. Where the row is too narrow
          for them beside the name, they drop to a line of their own under
          it, lined up with the name. */}
      {hasActions && (
        <div className="flex w-full flex-wrap items-center justify-end gap-1 @[32rem]:w-auto @[32rem]:shrink-0">
          {canToggleAdmin && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              aria-label={
                p.role === "admin"
                  ? `Remove admin from ${actionLabel}`
                  : `Make ${actionLabel} an admin`
              }
              disabled={updateRolePending}
              onClick={() =>
                onUpdateRole(p.userId, p.role === "admin" ? "member" : "admin")
              }
            >
              {p.role === "admin" ? (
                <>
                  <ShieldOff className="size-3.5" />
                  Remove admin
                </>
              ) : (
                <>
                  <Shield className="size-3.5" />
                  Make admin
                </>
              )}
            </Button>
          )}
          {canMakeOwner && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              aria-label={`Make ${actionLabel} the owner`}
              disabled={transferOwnershipPending}
              onClick={() => onTransferOwnership(p.userId, actionLabel)}
            >
              <Crown className="size-3.5" />
              Make owner
            </Button>
          )}
          {canRemove && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs text-destructive hover:text-destructive"
              aria-label={`Remove ${actionLabel}`}
              disabled={removePending}
              onClick={() => onRemove(p.userId, actionLabel)}
            >
              <UserMinus className="size-3.5" />
              Remove
            </Button>
          )}
        </div>
      )}
    </li>
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
