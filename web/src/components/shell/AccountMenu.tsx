import { type KeyboardEvent, useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import {
  ChevronsUpDown,
  Keyboard,
  LogOut,
  Settings,
  User,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { UserStatusBadge } from "@/components/UserStatusBadge";
import type { Session } from "@/lib/api";
import { usePopover } from "@/lib/popover";
import { openOverlay } from "@/lib/shell";
import { isStatusVisible, useUserStatus } from "@/lib/status";
import { userAvatarName, userLabel } from "@/lib/users";
import { cn } from "@/lib/utils";

const itemClassName =
  "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent";

// The desktop account cluster (issue #554): the username link, settings icon
// and "Log out" button that sit loose in the phone/tablet bar collapse into
// one avatar button at the foot of the sidebar, opening a menu upward.
export function AccountMenu({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => void;
}) {
  const {
    open,
    setOpen,
    toggle,
    rootRef,
    triggerRef,
    panelRef,
    panelId,
    mounted,
    exiting,
  } = usePopover();
  const user = session.user;
  const status = useUserStatus(user.id, user);
  const itemsRef = useRef<HTMLElement[]>([]);

  // Opening moves focus to the first item, as a menu should.
  useEffect(() => {
    if (open) itemsRef.current[0]?.focus();
  }, [open]);

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = itemsRef.current.filter(Boolean);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(current + step + items.length) % items.length]?.focus();
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        ref={triggerRef}
        aria-expanded={open}
        // The panel unmounts once closed, so it's only pointed at while open.
        aria-controls={open ? panelId : undefined}
        onClick={toggle}
        aria-haspopup="menu"
        aria-label={`Account menu for ${userLabel(user)}`}
        title={userLabel(user)}
        className={cn(
          "flex w-full items-center justify-center gap-3 rounded-xl p-1.5 text-left transition-colors hover:bg-accent/50 xl:justify-start xl:px-2",
          "outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open && "bg-accent/60",
        )}
      >
        <Avatar
          name={userAvatarName(user)}
          avatarUrl={user.avatarUrl}
          avatarVariants={user.avatarVariants}
        />
        <span className="hidden min-w-0 flex-1 flex-col leading-tight xl:flex">
          <span className="truncate text-sm font-medium">
            {userLabel(user)}
          </span>
          {/* Just the name — like the top bar, the display name stands
              in for the handle in the nav (the profile shows both). */}
          {isStatusVisible(status) && (
            <UserStatusBadge
              status={status}
              className="text-xs text-muted-foreground"
            />
          )}
        </span>
        <ChevronsUpDown className="hidden size-4 shrink-0 text-muted-foreground xl:block" />
      </button>
      {mounted && (
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-label="Account"
          inert={!open}
          onKeyDown={onMenuKeyDown}
          // Clicking any item closes the menu, even one that doesn't move
          // the URL (log out on `/`, the shortcuts sheet).
          onClick={(e) => {
            if ((e.target as Element).closest("[role=menuitem]")) {
              setOpen(false);
            }
          }}
          className={cn(
            "absolute bottom-full left-0 z-40 mb-2 w-60 origin-bottom-left rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground shadow-2xl",
            exiting
              ? "motion-safe:animate-pop-close"
              : "motion-safe:animate-pop-open",
          )}
        >
          <Link
            ref={(node) => {
              if (node) itemsRef.current[0] = node;
            }}
            role="menuitem"
            to="/users/$id"
            params={{ id: String(user.id) }}
            className={itemClassName}
          >
            <User className="size-4 text-muted-foreground" />
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate font-medium">{userLabel(user)}</span>
              <span className="text-xs text-muted-foreground">
                View profile
              </span>
            </span>
          </Link>
          <Link
            ref={(node) => {
              if (node) itemsRef.current[1] = node;
            }}
            role="menuitem"
            to="/settings"
            className={itemClassName}
          >
            <MenuIcon icon={Settings} />
            Settings
          </Link>
          <button
            ref={(node) => {
              if (node) itemsRef.current[2] = node;
            }}
            type="button"
            role="menuitem"
            onClick={() => openOverlay("shortcuts")}
            className={itemClassName}
          >
            <MenuIcon icon={Keyboard} />
            Keyboard shortcuts
            <kbd className="ml-auto rounded border border-border px-1.5 text-[10px] text-muted-foreground">
              ?
            </kbd>
          </button>
          <div className="my-1 h-px bg-border" />
          <button
            ref={(node) => {
              if (node) itemsRef.current[3] = node;
            }}
            type="button"
            role="menuitem"
            onClick={onLogout}
            className={itemClassName}
          >
            <MenuIcon icon={LogOut} />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

function MenuIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-4 text-muted-foreground" />;
}
